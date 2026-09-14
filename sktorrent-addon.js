// SKTorrent Addon v2.0.0 + TORBOX + ČSFD
//
// Copyright (C) 2025 Matej Suchon
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

const { decode } = require("entities");
const axios = require("axios");
const cheerio = require("cheerio");
const bencode = require("bncode");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const express = require("express");
const FormData = require("form-data");
const path = require("path");
const cors = require("cors");
const fs = require("fs"); 
// const { csfd } = require('node-csfd-api'); 

const PORT = process.env.PORT || 7000; 
// const PUBLIC_URL = "https://bda31382-bef9-4743-b2e2-e9838ecb6690.eu-central-1.cloud.genez.io"; 
const PUBLIC_URL = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`); 
const BASE_URL = "https://sktorrent.eu"; 
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;

const agentOptions = { keepAlive: true, maxSockets: 50 };

// ===================================================================
// LOGOVACÍ SYSTÉM
// ===================================================================
function getTime() {
    return new Date().toLocaleString('sk-SK', { timeZone: 'Europe/Bratislava', hour12: false });
}
function logInfo(msg) { /* log removed for privacy */ }
function logSuccess(msg) { /* log removed for privacy */ }
function logWarn(msg) { /* log removed for privacy */ }
function logError(msg, err = "") { /* log removed for privacy */ }
function logCache(msg) { /* log removed for privacy */ }
function logApi(msg) { /* log removed for privacy */ }

// ===================================================================
// CACHE a CONCURRENCY SYSTÉM
// ===================================================================
const cache = new Map();

// Prázdne/null výsledky (ČSFD dočasne down, SKTorrent login error a pod.)
// sa nesmú cachovať na plnú TTL — inak by výpadok trval hodiny.
const PRAZDNY_TTL_MS = 60 * 1000; // 60s

// ===================================================================
// PRECACHE ĎALŠEJ EPIZÓDY (inšpirácia: AIOStreams "Pre-cache Next Episode")
// ===================================================================
// Anti-spam: rovnakú nasledujúcu epizódu (user + seriál + sezóna + ep) nechceme
// pre-cacheovať častejšie ako raz za 30 min. Mapa je in-memory (zmizne s reštartom).
const precacheCasovac = new Map();
const PRECACHE_MIN_INTERVAL_MS = 30 * 60 * 1000; // 30 min
// Mapa hash torrentu → pôvodné stream ID (pre trigger z /play, ktorý pozná len hash + S:E)
const precacheIdMap = new Map();

function jePrazdnyVysledok(data) {
    if (data === null || data === undefined) return true;
    if (Array.isArray(data)) return data.length === 0;
    if (typeof data === 'object') {
        // špeciálny tvar z metadata: { nazvy: [], rok: null, meta: {...} }
        if (Array.isArray(data.nazvy)) return data.nazvy.length === 0;
        return Object.keys(data).length === 0;
    }
    return false;
}

// Single-flight: ak už pre rovnaký key beží fetcher, počkáme naň namiesto
// paralelného opakovania (Stremio retry-uje requesty, nechceme 4x drahý search).
const inflight = new Map();

async function withCache(key, ttlMs, fetcher) {
    const existujuci = cache.get(key);
    if (existujuci && Date.now() < existujuci.expires) {
        logCache(`HIT: ${key}`);
        return existujuci.data;
    }
    if (inflight.has(key)) {
        logCache(`INFLIGHT WAIT: ${key}`);
        return inflight.get(key);
    }
    logCache(`MISS: ${key}`);
    const promise = (async () => {
        try {
            const data = await fetcher();
            const vyslednaTtl = jePrazdnyVysledok(data) ? PRAZDNY_TTL_MS : ttlMs;
            cache.set(key, { data, expires: Date.now() + vyslednaTtl });
            return data;
        } catch (error) {
            logError(`Failed to fetch key: ${key}`, error);
            return null;
        } finally {
            inflight.delete(key);
        }
    })();
    inflight.set(key, promise);
    return promise;
}

// Pravidelný sweep expirovaných záznamov — cache inak rastie donekonečna
// (expirácia sa doteraz kontrolovala len pri čítaní).
setInterval(() => {
    const teraz = Date.now();
    for (const [k, v] of cache) {
        if (teraz >= v.expires) cache.delete(k);
    }
}, 600000).unref(); // každých 10 min, neblokuje shutdown


function pLimit(limit) {
    let active = 0; const q = [];
    const next = () => {
        if (active >= limit || q.length === 0) return;
        active++;
        const { fn, resolve, reject } = q.shift();
        fn().then(resolve, reject).finally(() => { active--; next(); });
    };
    return (fn) => new Promise((resolve, reject) => { q.push({ fn, resolve, reject }); next(); });
}

// ===================================================================
// POMOCNÉ FUNKCIE PRE CONFIG A TEXT
// ===================================================================
function decodeConfig(configString) {
    try {
        if (!configString || configString.includes(".json")) return null;
        let base64 = configString.replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) { base64 += '='; }
        return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    } catch (e) {
        logWarn(`Failed to decode config: ${configString}`);
        return null;
    }
}

// Zdieľané keepAlive agenty — NIE nový http.Agent/https.Agent per request.
// Nové agenty per request by držali otvorené keepAlive sockety a leakovali.
const sharedHttpAgent = new http.Agent(agentOptions);
const sharedHttpsAgent = new https.Agent(agentOptions);

function getFastAxios(userConfig) {
    const { uid, pass } = userConfig;
    return axios.create({
        timeout: 5000, 
        httpAgent: sharedHttpAgent,
        httpsAgent: sharedHttpsAgent,
        headers: {
            "User-Agent": "Mozilla/5.0",
            "Cookie": `uid=${uid}; pass=${pass}`,
            "Referer": BASE_URL,
            "Connection": "keep-alive"
        }
    });
}

const langToFlag = { CZ: "🇨🇿", SK: "🇸🇰", EN: "🇬🇧", US: "🇺🇸", DE: "🇩🇪", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸", RU: "🇷🇺", PL: "🇵🇱", HU: "🇭🇺", JP: "🇯🇵" };

function odstranDiakritiku(str) { return str.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function skratNazov(title, pocetSlov = 3) { return title.split(/\s+/).slice(0, pocetSlov).join(" "); }

function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return "?";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0; let n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i >= 2 ? 2 : 0)} ${u[i]}`;
}

function getQualityRank(text = "") {
    const t = text.toLowerCase();
    if (t.includes("2160p") || t.includes("4k") || t.includes("uhd")) return 4;
    if (t.includes("1080p") || t.includes("fhd")) return 3;
    if (t.includes("720p") || /\bhd\b/.test(t)) return 2;
    if (t.includes("480p")) return 1;
    return 0;
}

function getSizeBytes(text = "") {
    const m = text.match(/(\d+(?:[.,]\d+)?)\s*(tb|gb|mb|kb)\b/i);
    if (!m) return 0;
    const value = parseFloat(m[1].replace(",", "."));
    const unit = m[2].toLowerCase();
    if (unit === "tb") return value * 1024 * 1024 * 1024 * 1024;
    if (unit === "gb") return value * 1024 * 1024 * 1024;
    if (unit === "mb") return value * 1024 * 1024;
    if (unit === "kb") return value * 1024;
    return 0;
}

// ÚPLNE ZMENENÁ FUNKCIA (bez použitia withCache z tvojej Map)
async function overitTorboxCache(infoHashes, torboxKey) {
    if (!torboxKey || !infoHashes || infoHashes.length === 0) return {};
    
    // TOTO JE TA OPRAVA: Najprv vyfiltruje vsetko co nie je undefined/null a az potom robi toLowerCase
    const platneHashe = infoHashes.filter(h => h && typeof h === 'string');
    if (platneHashe.length === 0) return {};

    const unikatneHashe = [...new Set(platneHashe)].map(h => h.toLowerCase());
    const hashString = unikatneHashe.sort().join(",");
    
    const cacheMap = {};
    
    logApi(`Checking TorBox cache directly for ${unikatneHashe.length} hashes`);

    // 1. Shared cache (checkcached) — rýchly, vždy prvý
    try {
        const res = await axios.get(`https://api.torbox.app/v1/api/torrents/checkcached`, {
            params: { hash: hashString, format: "list" },
            headers: { "Authorization": `Bearer ${torboxKey}` },
            timeout: 5000
        });

        if (res.data && res.data.success && res.data.data) {
            const poleDat = Array.isArray(res.data.data) ? res.data.data : [res.data.data];
            poleDat.forEach(item => { 
                if (item && item.hash) cacheMap[item.hash.toLowerCase()] = true; 
            });
        }
    } catch (error) {
        logError("TorBox checkcached failed", error);
    }

    // 2. Osobný účet (mylist) — len pre hashe ktoré checkcached nenašiel
    const chybajuceHashe = unikatneHashe.filter(h => !cacheMap[h]);
    if (chybajuceHashe.length > 0) {
        logApi(`checkcached nenasiel ${chybajuceHashe.length} hashov, skusam mylist`);
        try {
            const mylistRes = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
                headers: { Authorization: `Bearer ${torboxKey}` },
                timeout: 5000
            });

            if (mylistRes.data?.success && Array.isArray(mylistRes.data.data)) {
                for (const item of mylistRes.data.data) {
                    if (!item.hash) continue;
                    const h = item.hash.toLowerCase();
                    // POZOR: `download_finished` ostáva true AJ po expirácii — torrent
                    // v stave expired/incomplete/reported missing už nie je hrateľný
                    // (requestdl vracia DATABASE_ERROR). Jediný spoľahlivý indikátor
                    // dostupnosti súborov je `cached === true` (overené na reálnych
                    // dátach: completed/uploading/stopped seeding → cached=true,
                    // expired/incomplete/reported missing → cached=false).
                    if (chybajuceHashe.includes(h) && item.cached === true) {
                        if (!cacheMap[h]) {
                            cacheMap[h] = true;
                            logCache(`Torrent najdeny v mylist (cached): ${h.substring(0,12)}...`);
                        }
                    }
                }
            }
        } catch (error) {
            logWarn(`TorBox mylist check failed (volitelne): ${error.message}`);
        }
    } else {
        logApi(`checkcached nasiel vsetky hashe, mylist nepotrebny`);
    }

    logSuccess(`TorBox cache check complete. Found ${Object.keys(cacheMap).length}/${unikatneHashe.length} cached items.`);
    return cacheMap;
}

// ===================================================================
// REAL-DEBRID FUNKCIE (priame RD API + lokálna cache)
// ===================================================================
const RD_API_BASE = "https://api.real-debrid.com/rest/1.0";
const RD_CACHE_FILE = path.join(__dirname, "rd_cache.json");
const RD_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 dni
const RD_CACHE_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minut medzi pagináciami

// Zoznam patternov, ktore Real-Debrid blokuje (451 infringing_file)
const RD_BLOCKED_PATTERNS = [
    'bdrip', 'bd-rip', 'bd remux',
    'web-dl', 'webdl', 'web.dl',
    'webrip', 'web-rip', 'web.rip',
    'hdrip', 'hd-rip', 'hd.rip',
    'dvdrip', 'dvd-rip', 'dvd.rip',
    'rarbg', 'yts', 'eztv', 'tgx', 'amzn'
];

function jeRDNazovBlokovany(nazov) {
    if (!nazov) return false;
    const lower = nazov.toLowerCase();
    return RD_BLOCKED_PATTERNS.some(p => lower.includes(p));
}

// ===================================================================
// RD JSON CACHE (distribuovaná medzi userov)
// ===================================================================
let rdCache = {};
let rdCacheLoaded = false;
let rdLastRefresh = 0;
let rdRefreshPromise = null;

function nacitatRdCache() {
    try {
        if (fs.existsSync(RD_CACHE_FILE)) {
            const raw = fs.readFileSync(RD_CACHE_FILE, 'utf-8');
            rdCache = JSON.parse(raw);
            const now = Date.now();
            for (const hash in rdCache) {
                if (now - rdCache[hash].cached_at > RD_CACHE_MAX_AGE) {
                    delete rdCache[hash];
                }
            }
        }
    } catch (e) {
        logWarn(`RD cache load failed: ${e.message}`);
        rdCache = {};
    }
    rdCacheLoaded = true;
    logInfo(`RD cache loaded: ${Object.keys(rdCache).length} hashes`);
}

function ulozitRdCache() {
    try {
        const dir = path.dirname(RD_CACHE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(RD_CACHE_FILE, JSON.stringify(rdCache, null, 0), 'utf-8');
    } catch (e) {
        logWarn(`RD cache save failed: ${e.message}`);
    }
}

// ===================================================================
// RD API HELPERY (priame volania)
// ===================================================================
const RD_AXIOS_TIMEOUT = 20000;

function rdHeaders(apiKey) {
    return { "Authorization": `Bearer ${apiKey}`, "User-Agent": "TorrentSK/1.0" };
}

async function rdAddMagnet(apiKey, hash) {
    const magnet = `magnet:?xt=urn:btih:${hash}`;
    const res = await axios.post(`${RD_API_BASE}/torrents/addMagnet`,
        `magnet=${encodeURIComponent(magnet)}`,
        { headers: { ...rdHeaders(apiKey), "Content-Type": "application/x-www-form-urlencoded" }, timeout: RD_AXIOS_TIMEOUT }
    );
    return res.data;
}

async function rdSelectFiles(apiKey, torrentId, fileIds) {
    const res = await axios.post(`${RD_API_BASE}/torrents/selectFiles/${torrentId}`,
        `files=${fileIds}`,
        { headers: { ...rdHeaders(apiKey), "Content-Type": "application/x-www-form-urlencoded" }, timeout: RD_AXIOS_TIMEOUT }
    );
    return res.status === 204;
}

async function rdTorrentInfo(apiKey, torrentId) {
    const res = await axios.get(`${RD_API_BASE}/torrents/info/${torrentId}`,
        { headers: rdHeaders(apiKey), timeout: RD_AXIOS_TIMEOUT }
    );
    return res.data;
}

async function rdUnrestrictLink(apiKey, link) {
    const res = await axios.post(`${RD_API_BASE}/unrestrict/link`,
        `link=${encodeURIComponent(link)}`,
        { headers: { ...rdHeaders(apiKey), "Content-Type": "application/x-www-form-urlencoded" }, timeout: RD_AXIOS_TIMEOUT }
    );
    return res.data;
}

async function rdDeleteTorrent(apiKey, torrentId) {
    await axios.delete(`${RD_API_BASE}/torrents/delete/${torrentId}`,
        { headers: rdHeaders(apiKey), timeout: 10000 }
    );
}

async function rdListTorrents(apiKey, page = 1, limit = 100) {
    const res = await axios.get(`${RD_API_BASE}/torrents?page=${page}&limit=${limit}`,
        { headers: rdHeaders(apiKey), timeout: 15000 }
    );
    return Array.isArray(res.data) ? res.data : [];
}

// ===================================================================
// PAGINÁCIA /torrents DO CACHE
// ===================================================================
async function rdPaginateTorrents(apiKey) {
    logApi(`RD paginácia /torrents na refresh cache...`);
    let page = 1;
    const limit = 100;
    let total = 0;

    while (page <= 50) {
        const items = await rdListTorrents(apiKey, page, limit);
        if (!items.length) break;

        for (const t of items) {
            if (t.status === 'downloaded' && t.hash) {
                const h = t.hash.toLowerCase();
                if (!rdCache[h]) {
                    rdCache[h] = { cached_at: Date.now() };
                    total++;
                }
            }
        }

        if (items.length < limit) break;
        page++;
    }

    rdLastRefresh = Date.now();
    ulozitRdCache();
    logSuccess(`RD cache refresh: pridaných ${total} nových hashov (spolu ${Object.keys(rdCache).length})`);
}

// ===================================================================
// NOVÝ RD CACHE CHECK (lokálna cache + fallback /torrents)
// ===================================================================
async function overitRealDebridCache(infoHashes, rdKey) {
    if (!rdKey || !infoHashes || infoHashes.length === 0) return {};

    if (!rdCacheLoaded) nacitatRdCache();

    const platneHashe = infoHashes.filter(h => h && typeof h === 'string');
    if (platneHashe.length === 0) return {};

    const unikatneHashe = [...new Set(platneHashe)].map(h => h.toLowerCase());
    const cacheMap = {};

    // 1. Lokálna cache — instant (zdieľaná databáza: hashe nahrané všetkými
    //    userami addonu pri úspešnom prehratí/stiahnutí cez RD + refresh)
    for (const hash of unikatneHashe) {
        if (rdCache[hash]) {
            cacheMap[hash] = true;
        }
    }
    logCache(`RD cache: ${Object.keys(cacheMap).length}/${unikatneHashe.length} z lokálnej cache`);

    // 2. Ak nejaké chýbajú, skúsime refresh /torrents (max 1x za 5 min)
    //    — pridá hashe so statusom 'downloaded' z účtu aktívneho usera
    const chybajuceHashe = unikatneHashe.filter(h => !cacheMap[h]);
    const now = Date.now();

    if (chybajuceHashe.length > 0 && (now - rdLastRefresh > RD_CACHE_REFRESH_INTERVAL)) {
        if (!rdRefreshPromise) {
            rdRefreshPromise = rdPaginateTorrents(rdKey).finally(() => {
                rdRefreshPromise = null;
            });
        }

        try {
            await Promise.race([
                rdRefreshPromise,
                new Promise(r => setTimeout(r, 30000))
            ]);
        } catch (e) {
            logWarn(`RD cache refresh zlyhal: ${e.message}`);
        }

        for (const hash of chybajuceHashe) {
            if (rdCache[hash]) {
                cacheMap[hash] = true;
                logCache(`RD cached po refreshi: ${hash.substring(0,12)}...`);
            }
        }
    }

    return cacheMap;
}

async function overitDebridCache(infoHashes, apiKey, provider) {
    if (provider === 'torbox') {
        return overitTorboxCache(infoHashes, apiKey);
    } else if (provider === 'realdebrid') {
        return overitRealDebridCache(infoHashes, apiKey);
    }
    return {};
}

// ===================================================================
// ZÍSKANIE ČSFD LINKU VLASTNÝM RIEŠENÍM (Axios + Cheerio)
// ===================================================================
async function ziskatCsfdUrl(imdbId, nazov, rok, vlastnyTyp) {
    return withCache(`csfd_url_v2:${imdbId}`, 86400000, async () => {
        logApi(`Hľadám ČSFD dáta (vlastný scraper) pre IMDB: ${imdbId} (Názov: ${nazov}, Rok: ${rok}, Typ: ${vlastnyTyp})`);
        try {
            const query = encodeURIComponent(nazov);
            const searchUrl = `https://www.csfd.cz/hledat/?q=${query}`;
            
            // 1. Odošleme požiadavku s prehliadačovými hlavičkami
            const res = await axios.get(searchUrl, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                    "Accept-Language": "sk,cs;q=0.9,en-US;q=0.8,en;q=0.7"
                },
                timeout: 6000
            });

            // 2. ČSFD nás niekedy pri presnej zhode okamžite presmeruje na profil filmu/seriálu
            const finalUrl = res.request?.res?.responseUrl;
            if (finalUrl && finalUrl.includes("/film/")) {
                logSuccess(`ČSFD priamo presmerovalo na: ${finalUrl}`);
                return finalUrl;
            }

            // 3. Ak sme na stránke s výsledkami hľadania, zanalyzujeme štruktúru cez Cheerio
            const $ = cheerio.load(res.data);
            let najdeneVysledky = [];

            $('.article-header').each((i, el) => {
                const linkElement = $(el).find('a.film-title-name');
                const urlPath = linkElement.attr('href');
                const rawInfo = $(el).find('.info').text() || ""; 
                
                if (urlPath && urlPath.includes('/film/')) {
                    // Skúsime nájsť rok v zátvorke, napr. (2009) alebo (seriál) (2010)
                    const rokMatch = rawInfo.match(/\b(19|20)\d{2}\b/);
                    const zaznamRok = rokMatch ? parseInt(rokMatch[0]) : null;
                    
                    // Rozpoznanie, či ide o seriál
                    const jeSerial = rawInfo.toLowerCase().includes('seriál') || rawInfo.toLowerCase().includes('série');
                    
                    najdeneVysledky.push({
                        url: urlPath.startsWith("http") ? urlPath : `https://www.csfd.cz${urlPath}`,
                        rok: zaznamRok,
                        jeSerial: jeSerial
                    });
                }
            });

            if (najdeneVysledky.length === 0) {
                logWarn(`Vlastný scraper nenašiel žiadne výsledky pre: ${nazov}`);
                return null;
            }

            // 4. Zoradíme a filtrujeme výsledky podľa typu (Filmy vs Seriály)
            let filtrovane = najdeneVysledky;
            if (vlastnyTyp === "series") {
                const serialy = najdeneVysledky.filter(v => v.jeSerial);
                if (serialy.length > 0) filtrovane = serialy;
            } else if (vlastnyTyp === "movie") {
                const filmy = najdeneVysledky.filter(v => !v.jeSerial);
                if (filmy.length > 0) filtrovane = filmy;
            }

            // 5. Nájdeme najlepšiu zhodu roka (+/- 1 rok)
            let najdeny = filtrovane.find(v => v.rok === rok || v.rok === rok - 1 || v.rok === rok + 1);
            if (!najdeny) najdeny = filtrovane[0]; // Ak sa rok nenašiel, vrátime prvý najlepší výsledok

            logSuccess(`Úspešne nájdené ČSFD URL (vlastný scraper): ${najdeny.url}`);
            return najdeny.url;

        } catch (error) {
            logError(`Chyba pri vlastnom získavaní ČSFD URL pre ${nazov}`, error);
            return null;
        }
    });
}

// ===================================================================
// ZÍSKANIE ČSFD LINKU CEZ node-csfd-api
// ===================================================================
// async function ziskatCsfdUrl(imdbId, nazov, rok, vlastnyTyp) {
//     return withCache(`csfd_url_v2:${imdbId}`, 86400000, async () => {
//         logApi(`Hľadám ČSFD dáta pre IMDB: ${imdbId} (Názov: ${nazov}, Rok: ${rok}, Typ: ${vlastnyTyp})`);
//         try {
//             const hladanie = await csfd.search(nazov);

//             let vsetkyVysledky = [];
//             if (vlastnyTyp === "series" && hladanie.tvSeries) {
//                 vsetkyVysledky = hladanie.tvSeries;
//             } else if (vlastnyTyp === "movie" && hladanie.movies) {
//                 vsetkyVysledky = hladanie.movies;
//             } else {
//                 vsetkyVysledky = [...(hladanie.movies || []), ...(hladanie.tvSeries || [])];
//             }

//             if (vsetkyVysledky.length === 0) {
//                 logWarn(`ČSFD nenašlo žiadne ${vlastnyTyp} výsledky pre: ${nazov}`);
//                 return null;
//             }

//             let najdeny = vsetkyVysledky.find(v => v.year === rok || v.year === rok - 1 || v.year === rok + 1);
//             if (!najdeny) najdeny = vsetkyVysledky[0];

//             let urlPath = najdeny.url;
//             const csfdUrl = urlPath.startsWith("http") ? urlPath : `https://www.csfd.cz${urlPath}`;

//             logSuccess(`Úspešne nájdené ČSFD URL: ${csfdUrl}`);
//             return csfdUrl;
//         } catch (error) {
//             logError(`Chyba pri získavaní ČSFD URL pre ${nazov}`, error);
//             return null;
//         }
//     });
// }

// ===================================================================
// FILTRE PRE NÁZVY A SERIÁLY
// ===================================================================
function torrentSedisSeriou(nazovTorrentu, seria) {
    // 1. Zistíme, či ide o rozsah sérií (vrátane zápisov ako "1. - 4. serie").
    // Ak je to rozsah (napr. S01-S03), necháme ho prejsť.
    if (
        /S\d{1,2}\s*[-–]\s*S?\d{1,2}/i.test(nazovTorrentu) || 
        /Seasons?\s*\d{1,2}\s*[-–]\s*\d{1,2}/i.test(nazovTorrentu) ||
        /\b\d{1,2}\.?\s*[-–]\s*\d{1,2}\.?\s*s[eé]rie/i.test(nazovTorrentu) ||
        /\bs[eé]ri[ae]\s*\d{1,2}\s*[-–]\s*\d{1,2}\b/i.test(nazovTorrentu)
    ) {
        return true; 
    }
    // 2. Kontrola, či to nie je EXPLICITNE INÁ samostatná séria 
    const serieMatch = nazovTorrentu.match(/\b(\d+)\.\s*s[eé]rie/i);
    if (serieMatch && parseInt(serieMatch[1], 10) !== seria) return false;

    const seasonMatch = nazovTorrentu.match(/\bSeason\s+(\d+)\b/i);
    if (seasonMatch && parseInt(seasonMatch[1], 10) !== seria) return false;

    // --- PRIDANÁ OPRAVA: Kontrola presného formátu SxxEyy ---
    // Ak torrent jasne hovorí, že ide napr. o S01E10, a my hľadáme Sériu 3, okamžite ho vyradíme
    const seMatch = nazovTorrentu.match(/\bS(\d{1,2})[._-]?E\d{1,3}\b/i);
    if (seMatch && parseInt(seMatch[1], 10) !== seria) return false;

    // --- PRIDANÁ OPRAVA: Kontrola formátu 1x01 ---
    const xMatch = nazovTorrentu.match(/\b(\d{1,2})x\d{1,3}\b/i);
    if (xMatch && parseInt(xMatch[1], 10) !== seria) return false;

    // Kontrola pre osamotené Sxx (napríklad S01, ale ignoruje, ak nasleduje E)
    const sMatch = nazovTorrentu.match(/\bS(\d{2})(?!E)/i);
    if (sMatch && parseInt(sMatch[1], 10) !== seria) return false;

    return true;
}

function torrentSediSEpizodou(nazov, seria, epizoda) {
    // 1. Hľadáme rozsahy sérií naprieč rôznymi formátmi
    const range =
        nazov.match(/\bS(\d{1,2})\s*[-–]\s*S?(\d{1,2})\b/i) ||
        nazov.match(/\bSeason\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\b/i) ||
        nazov.match(/\bSeasons\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\b/i) ||
        nazov.match(/\b(\d{1,2})\.?\s*[-–]\s*(\d{1,2})\.?\s*s[eé]rie\b/i) ||
        // TOTO JE NOVE: zachyti "Seria 1-13", "Série 1-12", atď.
        nazov.match(/\bs[eé]ri[ae]\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\b/i); 

    if (range) {
        // Musíme si dať pozor, ktoré zachytené skupiny čísel idú do 'a' a 'b'.
        // Pretože pri rôznych regexoch môžu byť zachytené v iných skupinách (vďaka '||')
        // Najbezpečnejšie je jednoducho nájsť prvé dve čísla z výsledku .match
        const nums = range.filter(x => x !== undefined && /^\d+$/.test(x));
        if (nums.length >= 2) {
            const a = parseInt(nums[0], 10);
            const b = parseInt(nums[1], 10);
            const lo = Math.min(a, b);
            const hi = Math.max(a, b);
            // Ak naša hľadaná séria spadá do tohto rozsahu ("1. - 4."), pustíme ho ako Pack
            if (seria >= lo && seria <= hi) return true; 
        }
    }

    const seriaStr = String(seria).padStart(2, "0");
    const epStr = String(epizoda).padStart(2, "0");
    let toMaZluEpizodu = false;

    // Overenie špecifických epizód S01E01 a pod.
    const vsetkyE = [...nazov.matchAll(new RegExp(`S${seriaStr}[._-]?E(\\d{1,3})\\b`, "gi"))];
    if (vsetkyE.length > 0) {
        const maNasu = vsetkyE.some(m => parseInt(m[1]) === parseInt(epizoda));
        if (!maNasu) toMaZluEpizodu = true;
    }

    const vsetkyX = [...nazov.matchAll(new RegExp(`\\b${seria}x(\\d{1,3})\\b`, "gi"))];
    if (vsetkyX.length > 0) {
        const maNasu = vsetkyX.some(m => parseInt(m[1]) === parseInt(epizoda));
        if (!maNasu) toMaZluEpizodu = true;
    }

    const jeToRozsahE = nazov.match(/E(\d{1,3})\s*[-–]\s*E?(\d{1,3})\b/i);
    if (jeToRozsahE) {
        const zaciatokE = parseInt(jeToRozsahE[1]);
        const koniecE = parseInt(jeToRozsahE[2]);
        if (epizoda >= zaciatokE && epizoda <= koniecE) {
            toMaZluEpizodu = false; 
        }
    }

    if (toMaZluEpizodu) return false; 

    // Explicitná zhoda pre požadovanú epizódu
    if (new RegExp(`S${seriaStr}[._-]?E${epStr}\\b`, "i").test(nazov)) return true;
    if (new RegExp(`\\b${seria}x${epStr}\\b`, "i").test(nazov)) return true;
    if (new RegExp(`\\b0*${epizoda}[._\\s-]*(?:Epiz[oó]da|Diel|Časť|Cast)\\b`, "i").test(nazov)) return true;
    // Rozsahy epizód ako "E01-E10" alebo "Dily 1-10"
    const rozsahEpizod = nazov.match(/E(\d{1,3})\s*[-–]\s*E?(\d{1,3})\b/i) || 
                         nazov.match(/(?:Dily?|Parts?|Epizody?|Eps?|Ep)[._\s]*(\d{1,3})\s*[-–]\s*(\d{1,3})\b/i);
    if (rozsahEpizod) {
        const zaciatok = parseInt(rozsahEpizod[1] || rozsahEpizod[2]);
        const koniec = parseInt(rozsahEpizod[2] || rozsahEpizod[3]);
        if (epizoda >= zaciatok && epizoda <= koniec) return true;
    }

    // Ak nie je špecifikovaná epizóda, ale sedí séria (Alebo obsahuje kľúčové slovo pre celý Pack / Part)
    const jeToCelaSeria = new RegExp(`\\b${seria}\\.\\s*s[eé]rie\\b`, "i").test(nazov) || 
                          new RegExp(`\\bs[eé]ri[ae]\\s*${seria}\\b`, "i").test(nazov) || 
                          new RegExp(`\\bSeason\\s*${seria}\\b`, "i").test(nazov) || 
                          new RegExp(`\\bS${seriaStr}\\b`, "i").test(nazov) ||
                          /\b(Pack|Komplet|Complete|Vol|Volume|Part|Časť|Cast|1\.\s*-\s*\d{1,2}\.)\b/i.test(nazov);
                          
    return jeToCelaSeria;
}


// ===================================================================
// Získanie názvov (Súbežne TMDB + Cinemeta) a ADVANCED METADATA
// ===================================================================
function parseYearRange(y) {
    if (!y) return { yearStart: null, yearEnd: null };
    const s = String(y).trim();
    const m = s.match(/^(\d{4})(?:\s*-\s*(\d{4})?)?$/);
    if (!m) return { yearStart: null, yearEnd: null };
    return { yearStart: m[1] ? parseInt(m[1]) : null, yearEnd: m[2] ? parseInt(m[2]) : null };
}

// ── TVDB global token cache ──────────────────────────────────────────────
let tvdbTokenCache = { token: null, expiresAt: 0 };

async function getTvdbToken(tvdbKey) {
    if (tvdbKey && tvdbTokenCache.token && Date.now() < tvdbTokenCache.expiresAt - 60000) {
        return tvdbTokenCache.token;
    }
    try {
        const res = await axios.post("https://api4.thetvdb.com/v4/login", { apikey: tvdbKey }, { timeout: 5000 });
        const data = res.data?.data;
        if (data?.token) {
            tvdbTokenCache.token = data.token;
            tvdbTokenCache.expiresAt = Date.now() + 3600000; // 1h default
            logSuccess(`TVDB token obtained`);
            return data.token;
        }
    } catch (e) { logError("TVDB login failed", e); }
    return null;
}

async function pridajTvdbNazvy(nazvy, tvdbId, tvdbKey) {
    const token = await getTvdbToken(tvdbKey);
    if (!token) return;
    
    // Paralelne namiesto sekvenčne — 3 volania naraz (ušetrí ~2x latenciu)
    await Promise.allSettled(["slk", "ces", "eng"].map(async (lang) => {
        try {
            const res = await axios.get(`https://api4.thetvdb.com/v4/series/${tvdbId}/translations/${lang}`, {
                headers: { "Authorization": `Bearer ${token}` },
                timeout: 4000
            });
            const name = res.data?.data?.name;
            if (name && name.trim()) {
                nazvy.add(name.trim());
                logApi(`TVDB (${lang}): ${name.trim()}`);
            }
        } catch (e) { /* translation not found for this lang, skip */ }
    }));
}

// IMDb suggestion fallback — keď Cinemeta aj TMDB zlyhajú (nové/neznáme tituly).
// IMDb suggestion API je verejné, bez kľúča: https://v2.sg.media-imdb.com/suggestion/t/<id>.json
async function pridajImdbSuggestionNazov(nazvy, imdbId) {
    if (!imdbId || !/^tt\d+$/.test(imdbId)) return false;
    try {
        const res = await axios.get(`https://v2.sg.media-imdb.com/suggestion/t/${imdbId}.json`, {
            timeout: 4000
        });
        const item = res.data?.d?.[0];
        if (item?.l && item.l.trim()) {
            nazvy.add(item.l.trim());
            logApi(`IMDb suggestion: ${item.l.trim()}`);
            return true;
        }
    } catch (e) { /* ignore */ }
    return false;
}

// TMDB fallback podľa TMDB ID — pre seriály z AioMetadata (tmdb:295879),
// ktoré Cinemeta nepozná. Používa tmdbKey z user configu (rovnaký vzor ako ziskatVsetkyNazvyARok).
async function pridajTmdbNazvy(nazvy, tmdbId, tmdbKey) {
    if (!tmdbKey) return;
    try {
        const [det, trans] = await Promise.all([
            axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}`, { params: { api_key: tmdbKey }, timeout: 4000 }).catch(() => null),
            axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}/translations`, { params: { api_key: tmdbKey }, timeout: 4000 }).catch(() => null)
        ]);
        if (det?.data) {
            if (det.data.name) nazvy.add(det.data.name.trim());
            if (det.data.original_name && det.data.original_name !== det.data.name) nazvy.add(det.data.original_name.trim());
        }
        if (trans?.data?.translations) {
            ["sk", "cs", "en"].forEach(lang => {
                const t = trans.data.translations.find(x => x.iso_639_1 === lang && x.data?.name);
                if (t?.data?.name) nazvy.add(t.data.name.trim());
            });
        }
    } catch (e) { /* ignore */ }
}

// TVDB fallback podľa IMDb ID — pre seriály, ktoré TMDB nepozná
// (napr. nové SK/CZ relácie ako "Párty Shore Slovensko" — TMDB prázdne,
// ale TVDB ich má). Search podľa imdbId → TVDB ID → preklady názvov.
async function pridajTvdbNazvyPodlaImdb(nazvy, imdbId, tvdbKey) {
    if (!imdbId || !tvdbKey) return false;
    const token = await getTvdbToken(tvdbKey);
    if (!token) return false;
    try {
        const res = await axios.get("https://api4.thetvdb.com/v4/search", {
            params: { imdbId },
            headers: { "Authorization": `Bearer ${token}` },
            timeout: 5000
        });
        const items = res.data?.data;
        if (Array.isArray(items) && items.length > 0) {
            const tvdbId = items[0].id;
            logApi(`TVDB search IMDb ${imdbId} → TVDB ID ${tvdbId}`);
            await pridajTvdbNazvy(nazvy, tvdbId, tvdbKey);
            return true;
        }
    } catch (e) {
        logWarn(`TVDB search IMDb ${imdbId} zlyhal: ${e.message}`);
    }
    return false;
}

async function ziskatVsetkyNazvyARok(imdbId, vlastnyTyp, tmdbKey, tvdbKey) {
    return withCache(`names_year_v2:${imdbId}`, 21600000, async () => { 
        logApi(`Fetching metadata pre IMDB ID: ${imdbId} (${vlastnyTyp})`);
        const nazvy = new Set();
        
        let titleOriginal = null;
        let titleCz = null;
        let yearStart = null;
        let yearEnd = null;

        const tmdbTyp = vlastnyTyp === "series" ? "tv" : "movie";
        
        const promises = [
            axios.get(`https://v3-cinemeta.strem.io/meta/${vlastnyTyp}/${imdbId}.json`, { timeout: 4000 }).catch(() => null)
        ];

        if (tmdbKey) {
            promises.push(
                axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, { params: { api_key: tmdbKey, external_source: "imdb_id" }, timeout: 4000 }).catch(() => null)
            );
        }

        const [cineRes, tmdbRes] = await Promise.all(promises);

        if (cineRes && cineRes.data?.meta) {
            const m = cineRes.data.meta;
            if (m.name) {
                nazvy.add(decode(m.name).trim());
                titleCz = decode(m.name).trim(); 
            }
            if (m.original_name) {
                nazvy.add(decode(m.original_name).trim());
                if (!titleOriginal) titleOriginal = decode(m.original_name).trim();
            }
            if (m.aliases) m.aliases.forEach(a => nazvy.add(decode(a).trim()));
            
            if (m.year) {
                const r = parseYearRange(m.year);
                yearStart = r.yearStart;
                yearEnd = r.yearEnd;
            }
        }

        let tmdbId = null;
        if (tmdbRes && tmdbRes.data) {
            if (vlastnyTyp === "series" && tmdbRes.data.tv_results?.length > 0) {
                const res = tmdbRes.data.tv_results[0];
                tmdbId = res.id;
                nazvy.add(res.name);
            } else if (vlastnyTyp === "movie" && tmdbRes.data.movie_results?.length > 0) {
                const res = tmdbRes.data.movie_results[0];
                tmdbId = res.id;
                nazvy.add(res.title);
            }
        }

        if (tmdbKey && tmdbId) {
            try {
                if (vlastnyTyp === "series") {
                    const det = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}`, { params: { api_key: tmdbKey }, timeout: 4000 });
                    if (!titleOriginal && det.data?.original_name) titleOriginal = det.data.original_name;
                    if (!yearStart && det.data?.first_air_date) yearStart = parseInt(det.data.first_air_date.slice(0,4));
                    if (!yearEnd && det.data?.last_air_date) yearEnd = parseInt(det.data.last_air_date.slice(0,4));
                } else {
                    const det = await axios.get(`https://api.themoviedb.org/3/movie/${tmdbId}`, { params: { api_key: tmdbKey }, timeout: 4000 });
                    if (!titleOriginal && det.data?.original_title) titleOriginal = det.data.original_title;
                    if (!yearStart && det.data?.release_date) yearStart = parseInt(det.data.release_date.slice(0,4));
                }

                const trans = await axios.get(`https://api.themoviedb.org/3/${tmdbTyp}/${tmdbId}/translations`, { params: { api_key: tmdbKey }, timeout: 4000 });
                if (trans.data?.translations) {
                    trans.data.translations.forEach(tr => {
                        const m = (tr.data || {}).title || (tr.data || {}).name;
                        if (m && ["cs", "sk", "en"].includes(tr.iso_639_1)) {
                            nazvy.add(m);
                            if (tr.iso_639_1 === "cs" && m) titleCz = m; // Update CZ title z TMDB ak existuje
                        }
                    });
                }
            } catch (e) { /* ignore */ }
        }

        // ── TVDB fallback: získať slovenský/český názov ──
        if (vlastnyTyp === "series" && tvdbKey) {
            if (tmdbId) {
                // Štandardná cesta: TMDB external_ids → TVDB ID
                try {
                    const extRes = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}/external_ids`, { params: { api_key: tmdbKey }, timeout: 4000 });
                    const tvdbId = extRes.data?.tvdb_id;
                    if (tvdbId) {
                        logApi(`TVDB fallback pre TMDB ID ${tmdbId} → TVDB ID ${tvdbId}`);
                        await pridajTvdbNazvy(nazvy, tvdbId, tvdbKey);
                    }
                } catch (e) { logWarn(`TVDB fallback failed pre TMDB ${tmdbId}`); }
            } else {
                // TMDB seriál nepozná (nové SK/CZ relácie) — TVDB search priamo podľa IMDb ID
                await pridajTvdbNazvyPodlaImdb(nazvy, imdbId, tvdbKey);
            }
        }

        if (!titleOriginal) titleOriginal = titleCz; 

        // IMDb suggestion fallback — keď všetko zlyhalo (Cinemeta {}, TMDB nič,
        // TVDB nič), aspoň anglický názov z IMDb (napr. "Dirty Shore" pre tt37432450)
        if (nazvy.size === 0) {
            await pridajImdbSuggestionNazov(nazvy, imdbId);
        }

        const vysledokNazvy = [...nazvy].filter(Boolean).filter(t => !t.toLowerCase().startsWith("výsledky"));
        return { 
            nazvy: vysledokNazvy, 
            rok: yearStart, 
            meta: { titleOriginal, titleCz, yearStart, yearEnd } 
        };
    });
}

// ===================================================================
// Hľadanie a spracovanie Torrentov
// ===================================================================
async function hladatTorrenty(dotaz, userAxios, maxPages = 1, userKey = "") {
    if (!dotaz || dotaz.trim().length < 2) return [];
    
    // Ak hľadáme cez exaktný ČSFD link, chceme načítať viac stránok 
    // (napr. až 8), aby sme zachytili seriály s desiatkami epizód.
    const skutocneMaxPages = dotaz.includes("csfd.cz") ? Math.min(maxPages, 2) : maxPages;
    
    // userKey = fingerprint účtu (hash uid) — výsledky závisia od SKTorrent session
    // (VIP status, viditeľnosť 18+ obsahu), preto cache NESMIE byť zdieľaná medzi userov
    return withCache(`search_paged_${userKey}_${skutocneMaxPages}:${dotaz}`, 600000, async () => {
        logApi(`Searching SKTorrent for: "${dotaz}" (Max pages: ${skutocneMaxPages})`);
        
        let vsetkyVysledky = [];
        const videnieIds = new Set();
        
        for (let page = 0; page < skutocneMaxPages; page++) {
            try {
                logInfo(`Fetching page ${page} for query: ${dotaz}`);
                const res = await userAxios.get(SEARCH_URL, { 
                    params: { 
                        search: dotaz, 
                        category: 0,
                        active: 0,
                        order: 'data',
                        by: 'DESC',
                        page: page 
                    } 
                });
                
                const $ = cheerio.load(res.data);
                let najdeneNaStranke = 0;

                $('a[href^="details.php"] img').each((i, img) => {
                    const rodic = $(img).closest("a");
                    const bunka = rodic.closest("td");
                    const text = bunka.text().replace(/\s+/g, " ").trim();
                    const odkaz = rodic.attr("href") || "";
                    const nazov = rodic.attr("title") || "";
                    const torrentId = odkaz.split("id=").pop();
                    
                    if (videnieIds.has(torrentId)) return; // Prevencia duplikátov
                    
                    const kategoria = bunka.find("b").first().text().trim();
                    const velkostMatch = text.match(/Velkost\s([^|]+)/i);
                    const seedMatch = text.match(/Odosielaju\s*:\s*(\d+)/i);

                    // Žánre torrentu (linky title="Filmový žáner X" / href*="zaner=")
                    // — potrebné pre 18+ filter (kategória môže byť "Filmy CZ/SK dabing",
                    // ale žáner "Eroticky" odhalí obsah). Čistá kategória xXx už odpadla
                    // vo filtri nižšie.
                    const zanre = [];
                    bunka.find('a[href*="zaner="]').each((j, el) => {
                        const t = $(el).text().trim();
                        if (t) zanre.push(t);
                    });

                    if (!kategoria.toLowerCase().includes("film") && !kategoria.toLowerCase().includes("seri") &&
                        !kategoria.toLowerCase().includes("dokum") && !kategoria.toLowerCase().includes("tv") &&
                        !kategoria.toLowerCase().includes("sport") && !kategoria.toLowerCase().includes("šport")) return;

                    videnieIds.add(torrentId);
                    vsetkyVysledky.push({
                        name: nazov, id: torrentId,
                        size: velkostMatch ? velkostMatch[1].trim() : "?",
                        seeds: seedMatch ? parseInt(seedMatch[1]) : 0,
                        category: kategoria,
                        zanre: zanre,
                        downloadUrl: `${BASE_URL}/torrent/download.php?id=${torrentId}`
                    });
                    najdeneNaStranke++;
                });

                logSuccess(`Found ${najdeneNaStranke} torrents on page ${page}`);
                
                // Ak sme na tejto stránke nenašli žiadne výsledky (alebo len veľmi málo, čo značí koniec),
                // nemá zmysel hľadať na ďalších stránkach.
                if (najdeneNaStranke < 10) {
                    logInfo(`Reached end of search results at page ${page}.`);
                    break;
                }

            } catch (chyba) {
                logError(`Search request failed for page ${page}`, chyba);
                break;
            }
        }
        
        return vsetkyVysledky.sort((a, b) => b.seeds - a.seeds); 
    });
}

function torrentValueToString(value) {
    if (!value) return null;
    if (Buffer.isBuffer(value)) return value.toString();
    if (typeof value === "string") return value;
    return String(value);
}

function extractTorrentTrackers(torrent) {
    const trackers = [];
    const addTracker = (value) => {
        const tracker = torrentValueToString(value);
        if (tracker && /^(https?|udp):\/\//i.test(tracker)) trackers.push(`tracker:${tracker}`);
    };

    addTracker(torrent.announce);

    const announceList = torrent["announce-list"];
    if (Array.isArray(announceList)) {
        announceList.flat(Infinity).forEach(addTracker);
    }

    return [...new Set(trackers)];
}

async function stiahnutTorrentData(url, userAxios) {
    return withCache(`torrent:${url}`, 86400000, async () => { 
        logApi(`Downloading .torrent file from: ${url}`);
        try {
            const res = await userAxios.get(url, { responseType: "arraybuffer" });
            const bufferString = res.data.toString("utf8", 0, 50);
            if (bufferString.includes("<html") || bufferString.includes("<!DOC")) {
                logWarn(`Received HTML instead of .torrent file from ${url}`);
                return null;
            }

            const torrent = bencode.decode(res.data);
            const info = bencode.encode(torrent.info);
            const infoHash = crypto.createHash("sha1").update(info).digest("hex");
            const trackers = extractTorrentTrackers(torrent);

            let subory = [];
            if (torrent.info.files) {
                subory = torrent.info.files.map((file, index) => {
                    const cesta = (file["path.utf-8"] || file.path || []).map(p => p.toString()).join("/");
                    const length = Number(file.length || 0); // Uloženie veľkosti v bytoch
                    return { path: cesta, index, length };
                });
            } else {
                const nazov = (torrent.info["name.utf-8"] || torrent.info.name || "").toString();
                const length = Number(torrent.info.length || 0); // Uloženie veľkosti v bytoch
                subory = [{ path: nazov, index: 0, length }];
            }

            logSuccess(`Successfully parsed .torrent (Hash: ${infoHash}, Trackers: ${trackers.length}) from ${url}`);
            return { infoHash, files: subory, trackers };
        } catch (chyba) {
            logError(`Failed to download/parse .torrent from ${url}`, chyba);
            return null;
        }
    });
}

async function vytvoritStream(t, seria, epizoda, userAxios, meta, userConfig) {
    logInfo(`Creating stream for torrent ID: ${t.id} (${t.name})`);
    
    // Debrid mode (TorBox/RD) alebo P2P
    const maDebrid = !!(userConfig?.torbox || userConfig?.realdebrid);
    
    let torrentData = null;
    torrentData = await stiahnutTorrentData(t.downloadUrl, userAxios);
    if (!torrentData) {
        const isHexHash = typeof t.id === "string" && /^[a-f0-9]{40}$/i.test(t.id);
        if (!isHexHash && !maDebrid) return null;
        if (isHexHash) {
            logInfo(`Torrent .torrent nedostupny, pouzivam priamy infoHash ${t.id}`);
        }
    }
    
    let najdenyIndex = -1;
    let najdenyNazovSuboru = null;

    // --- OČISTENIE NÁZVU (Hneď na začiatku, aby ho videl streamObj) ---
    let cistyNazov = t.name.replace(/^Stiahni si\s*/i, "").trim();
    if (t.category && typeof t.category === "string" && cistyNazov.toLowerCase().startsWith(t.category.trim().toLowerCase())) {
        cistyNazov = cistyNazov.slice(t.category.length).trim();
    }

    // --- VYHĽADANIE KONKRÉTNEJ EPIZÓDY ---
    // Pri debrid režime nemáme zoznam súborov, preskočíme a necháme /play handler
    if (torrentData && seria !== undefined && epizoda !== undefined) {
        const videoSubory = torrentData.files
            .filter(f => /\.(mp4|mkv|avi|m4v)$/i.test(f.path))
            .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));

        if (videoSubory.length === 0) return null;

        const epCislo = parseInt(epizoda);
        const epStr = String(epCislo).padStart(2, "0");
        const seriaStr = String(seria).padStart(2, "0");

if (videoSubory.length === 1) {
    const nazovSuboru = videoSubory[0].path;
    const najdeneESubor =
        nazovSuboru.match(new RegExp(`S${seriaStr}[._-]?E(\\d{1,3})\\b`, "i")) ||
        nazovSuboru.match(new RegExp(`\\b${seria}x(\\d{1,3})\\b`, "i")) ||
        nazovSuboru.match(new RegExp(`Ep(?:isode)?[._\\s]*(\\d{1,3})\\b`, "i")) ||
        nazovSuboru.match(new RegExp(`\\b(\\d{1,3})[._\\s]*(?:Epiz[oó]da|Diel|Časť|Cast)\\b`, "i")) ||
        nazovSuboru.match(new RegExp(`\\bE(\\d{1,3})\\b`, "i"));

    if (najdeneESubor && parseInt(najdeneESubor[1]) !== epCislo) return null;

    najdenyIndex = videoSubory[0].index;
    najdenyNazovSuboru = videoSubory[0].path;
} else {
    const epRegexy = [
        new RegExp(`[\\\\/](?:\\d+\\.\\s*s[eé]rie[\\\\/])?0*${epCislo}[\\s._-][^\\\\/]*\\.(?:mp4|mkv|avi|m4v)$`, "i"),
        new RegExp(`\\bS${seriaStr}[._-]?E${epStr}\\b`, "i"),
        new RegExp(`\\b${seria}x${epStr}\\b`, "i"),
        new RegExp(`\\b${seriaStr}x${epStr}\\b`, "i"),
        new RegExp(`\\b${seria}x0*${epCislo}\\b`, "i"),
        new RegExp(`S${seriaStr}[._-]?E${epStr}(?![0-9])`, "i"),
        new RegExp(`Ep(?:isode)?[._\\s]*0*${epCislo}\\b`, "i"),
        new RegExp(`\\b0*${epCislo}[._\\s-]*(?:Epiz[oó]da|Diel|Časť|Cast)\\b`, "i"),
        new RegExp(`\\bE${epStr}\\b`, "i"),
        new RegExp(`(?:^|[\\\\/])[\\s._-]*0*${epCislo}[\\s._-].*\\.(?:mp4|mkv|avi|m4v)$`, "i")
    ];

    for (let i = 0; i < epRegexy.length; i++) {
        const reg = epRegexy[i];
        const zhoda = videoSubory.find(f => reg.test(f.path));
        if (zhoda) {
            najdenyIndex = zhoda.index;
            najdenyNazovSuboru = zhoda.path;
            break;
        }
    }

    if (najdenyIndex === -1) {
        if (videoSubory.length === 1) {
            najdenyIndex = videoSubory[0].index;
            najdenyNazovSuboru = videoSubory[0].path;
            logWarn(`[TORRENT: ${t.name}] Nenájdená zhoda pre S${seria}E${epizoda}, ale použijem: ${najdenyNazovSuboru}`);
        } else {
            logWarn(`[TORRENT: ${t.name}] VYRADENÝ! Vo vnútri ${videoSubory.length} súborov nebol nájdený žiadny zodpovedajúci S${seria}E${epizoda}.`);
            return null;
        }
    } else {
        logSuccess(`[TORRENT: ${t.name}] ÚSPECH! Pre S${seria}E${epizoda} vybraný súbor: ${najdenyNazovSuboru}`);
    }
}
     } else if (torrentData) {
        // --- VYHĽADANIE SÚBORU PRE FILMY ---
        // Vyfiltrujeme video súbory a zoradíme ich podľa veľkosti zostupne (najväčší bude prvý)
        const videoSubory = torrentData.files
            .filter(f => /\.(mp4|mkv|avi|m4v)$/i.test(f.path))
            .sort((a, b) => (b.length || 0) - (a.length || 0));

        if (videoSubory.length > 0) {
            // Pre film vyberieme ten úplne najväčší video súbor (vyhneme sa tým "Sample" videám)
            najdenyIndex = videoSubory[0].index;
            najdenyNazovSuboru = videoSubory[0].path;
        } else if (torrentData.files.length > 0) {
            // Záloha: ak torrent nemá štandardnú video koncovku, zoberieme jednoducho najväčší súbor v torrente
            const najvacsiSubor = [...torrentData.files].sort((a, b) => (b.length || 0) - (a.length || 0))[0];
            najdenyIndex = najvacsiSubor.index;
            najdenyNazovSuboru = najvacsiSubor.path;
        }
    }
    

    // --- FORMÁTOVANIE METADÁT PRE TITLE ---
    const titleOriginalText = meta?.titleOriginal ? `${meta.titleOriginal}` : "";
    const titleCzText = meta?.titleCz ? `${meta.titleCz}` : "";
    const titleLine = titleCzText !== "" && titleOriginalText !== "" ? `${titleCzText} / ${titleOriginalText}` : (titleCzText !== "" ? titleCzText : titleOriginalText);

    let rokText = "📅 N/A";
    if (meta?.yearStart) {
        if (seria !== undefined) {
            rokText = meta.yearEnd && meta.yearStart !== meta.yearEnd ? `📅 ${meta.yearStart}-${meta.yearEnd}` : `📅 ${meta.yearStart}`;
        } else {
            rokText = `📅 ${meta.yearStart}`;
        }
    }

    const seriaEpizodaText = (seria !== undefined && epizoda !== undefined) ? `📺 Séria ${seria} • Epizóda ${epizoda}` : "";

    const analyzaNazvu = cistyNazov.toLowerCase();
    const kvality = [];
    if (analyzaNazvu.includes("2160p") || analyzaNazvu.includes("4k") || analyzaNazvu.includes("uhd")) kvality.push("4K");
    else if (analyzaNazvu.includes("1080p") || analyzaNazvu.includes("fhd")) kvality.push("1080p");
    else if (analyzaNazvu.includes("720p") || analyzaNazvu.includes("hd")) kvality.push("720p");
    else if (analyzaNazvu.includes("480p")) kvality.push("480p");

    if (analyzaNazvu.includes("hdr")) kvality.push("HDR");
    if (analyzaNazvu.includes("dovi") || analyzaNazvu.includes("vision")) kvality.push("Dolby Vision");
    if (analyzaNazvu.includes("hevc") || analyzaNazvu.includes("h265") || analyzaNazvu.includes("h.265") || analyzaNazvu.includes("x265")) kvality.push("HEVC");
    else if (analyzaNazvu.includes("x264") || analyzaNazvu.includes("h264") || analyzaNazvu.includes("h.264") || analyzaNazvu.includes("avc")) kvality.push("H.264");
    if (analyzaNazvu.includes("atmos")) kvality.push("Atmos");
    const sourceTypes = [];
    if (/\bweb[\s.-]?dl\b/i.test(cistyNazov)) sourceTypes.push('webdl');
    else if (/\bbluray\b|\bbdrip\b|\bbdremux\b/i.test(cistyNazov)) sourceTypes.push('bluray');
    if (/\bhdtv\b/i.test(cistyNazov)) sourceTypes.push('hdtv');
    if (/\bdvdrip\b/i.test(cistyNazov)) sourceTypes.push('dvdrip');
    if (/\bweb[\s.-]?rip\b/i.test(cistyNazov)) sourceTypes.push('webrip');
    if (/\bhdrip\b/i.test(cistyNazov)) sourceTypes.push('hdrip');
    if (/\bppv\b/i.test(cistyNazov)) sourceTypes.push('ppv');
    if (/\b(?:remux|remastered)\b/i.test(cistyNazov)) sourceTypes.push('remux');
    if (/\b(?:cam|tsrip|tele(?:sync|cine)|kino(?:rip)?)\b/i.test(cistyNazov)) sourceTypes.push('cam');
    if (/\b(?:scr(?:eener)?|dvdscr|bdscr|dvdscreener)\b/i.test(cistyNazov)) sourceTypes.push('screener');
    if (/\bvodrip\b|\bvod[-.\s]?rip\b/i.test(cistyNazov)) sourceTypes.push('vodrip');
    if (/\b(?:tvrip|satrip|dvbrip)\b/i.test(cistyNazov)) sourceTypes.push('tvrip');
    const sourceTag = sourceTypes.length > 0 ? sourceTypes.join(',') : 'neznámy';
    const kvalitaText = kvality.length > 0 ? `🎥 ${kvality.join(" • ")}` : "🎥 Kvalita neznáma";

    const hdrFeatures = [];
    if (analyzaNazvu.includes('hdr10')) hdrFeatures.push('hdr10');
    else if (analyzaNazvu.includes('hdr')) hdrFeatures.push('hdr');
    if (analyzaNazvu.includes('dovi') || analyzaNazvu.includes('vision')) hdrFeatures.push('dv');
    if (analyzaNazvu.includes('hevc') || analyzaNazvu.includes('h265') || analyzaNazvu.includes('x265')) hdrFeatures.push('hevc');
    if (analyzaNazvu.includes('atmos')) hdrFeatures.push('atmos');
    const hdrTag = hdrFeatures.length > 0 ? hdrFeatures.join(',') : '';
    const fileSize = torrentData && najdenyIndex !== -1 ? 
        (torrentData.files.find(f => f.index === najdenyIndex)?.length || 0) : 
        (torrentData ? torrentData.files.reduce((acc, f) => acc + (f.length || 0), 0) : 1048576);
    const formatFileSize = formatBytes(fileSize);
    const velkostText = `💿 ${formatFileSize} (🧩 ${t.size})`;

    const langMatch = cistyNazov.match(/\b(CZ|SK|EN)\b/ig) || [];
    const vlajkyList = langMatch.map(kod => langToFlag[kod.toUpperCase()]).filter(Boolean);
    const unikatneVlajky = [...new Set(vlajkyList)];
    let jazykText = "Neznámy jazyk";
    let jeSKCZ = false;
    if (unikatneVlajky.length > 0) {
        jazykText = unikatneVlajky.join(" / ");
        jeSKCZ = langMatch.some(l => /^(CZ|SK)$/i.test(l));
    } else if (langMatch.length > 0) {
        const textoveJazyky = [...new Set(langMatch.map(l => l.toUpperCase()))];
        jazykText = textoveJazyky.join(" / ");
        jeSKCZ = langMatch.some(l => /^(CZ|SK)$/i.test(l));
    }

    // Získanie počtu seedov (t.seeds je dostupné z tvojho vyhľadávacieho scrapera)
    const seedersText = t.seeds !== undefined ? `👥 Seeders: ${t.seeds}` : "👥 N/A";

    // Vytvorenie lepšie usporiadaného zoznamu
    const riadkyTitle = [];

        // Apply show config from user settings
    const showConfig = userConfig && userConfig.show;
    const shouldShow = function(field) {
        if (!showConfig || !Array.isArray(showConfig) || showConfig.length === 0) return true;
        return showConfig.indexOf(field) >= 0;
    };

    // Riadok 1: Skutočný Názov (CZ/EN) + Rok (čistý rok v zátvorke pre krajší dizajn)
    if (titleLine) {
        let rokCisty = rokText.replace("📅 ", ""); // Odstránime ikonu, nech to vyzerá filmovejšie
        riadkyTitle.push(`${titleLine} ${rokCisty !== "N/A" ? `(${rokCisty})` : ""}`);
    }

    // Riadok 2: TV Info (Séria a Epizóda) - zobrazí sa iba pri seriáloch
    if (seriaEpizodaText) {
        riadkyTitle.push(seriaEpizodaText);
    }

    // Riadok 3: Vlastnosti streamu (Jazyk a Kvalita oddelené čiarou)
    if (shouldShow('lang') || shouldShow('quality')) {
        var langPart = shouldShow('lang') ? jazykText : '';
        var qualPart = shouldShow('quality') ? kvalitaText : '';
        var sep = langPart && qualPart ? '   |   ' : '';
        riadkyTitle.push(`🔊 ${langPart}${sep}${qualPart}`);
    }

    // Riadok 4: Technické info (Veľkosť a počet Seedov)
    if (shouldShow('size') || shouldShow('seeds')) {
        var sizePart = shouldShow('size') ? velkostText : '';
        var seedPart = shouldShow('seeds') ? seedersText : '';
        var sep2 = sizePart && seedPart ? '   |   ' : '';
        riadkyTitle.push(`${sizePart}${sep2}${seedPart}`);
    }

    // Riadok 5: Konkrétny nájdený súbor, ktorý sa ide prehrať (Ak sa našiel v packu)
    if (najdenyNazovSuboru) {
        const ibaNazovSuboru = najdenyNazovSuboru.split('/').pop().split('\\').pop();
        riadkyTitle.push(`📄 Súbor: ${ibaNazovSuboru}`);
    }

    // Riadok 6: Originálny názov Torrent / Pack názov (na konci, lebo býva najdlhší a najviac "škaredý")
    riadkyTitle.push(`🗂️ Torrent: ${cistyNazov}`);

    // -- OŠETRENIE BEZPEČNEJ VEĽKOSTI --
    const bezpecnaVelkost = (fileSize && fileSize > 0) ? fileSize : 1048576; 

    // OČISTENIE NÁZVU SÚBORU
    const povodnySubor = najdenyNazovSuboru || "video.mkv";
    let cistyNazovSuboru = povodnySubor.split('/').pop().split('\\').pop();
    // Pôvodne tu bolo: cistyNazovSuboru = cistyNazovSuboru.replace(/[^a-zA-Z0-9.\-]/g, '_');
    // Odstránené - encodeURIComponent v URL a decodeURIComponent v play handleri
    // sa postarajú o správne kódovanie. Tento regex ničil diakritiku (Č, ň, ť, š)
    // a spôsoboval zlyhanie zhody názvu súboru v TorBox mylist.

    // Zistenie či je názov blokovaný Real-Debridom (451)
    const kontrolaNazvov = [cistyNazov, najdenyNazovSuboru || ''].filter(Boolean).join(' ');
    const jeRdBlokovany = jeRDNazovBlokovany(kontrolaNazvov);

    const defaultTrackers = [
        "tracker:http://tracker.sktorrent.eu:2710/announce",
        "tracker:udp://tracker.opentrackr.org:1337/announce",
        "tracker:udp://open.stealth.si:80/announce"
    ];

    // --- FINÁLNE TVORENIE OBJEKTU
    let streamObj = {
        name: `SKT\n${(t.category || "SPORT").toUpperCase()}`,
        title: riadkyTitle.join("\n"),
        behaviorHints: { 
            bingeGroup: `sktorrent-${kvality.length > 0 ? kvality.join("-").replace(/\s/g, "") : "standard"}`
        },
        sktId: t.id,
        fileName: cistyNazovSuboru,
        infoHash: torrentData ? torrentData.infoHash : t.id,
        fileIdx: najdenyIndex === -1 ? 0 : najdenyIndex,
        sources: (torrentData && Array.isArray(torrentData.trackers) && torrentData.trackers.length > 0) ? torrentData.trackers : defaultTrackers,
        isDub: jeSKCZ,
        seeds: t.seeds,
        _sortHdr: hdrTag,
        _sortSource: sourceTag,
        _sortRdBlocked: jeRdBlokovany ? 1 : 0,
        _sortName: cistyNazov,
        _sortCategory: t.category || "",
        _sortZaner: Array.isArray(t.zanre) ? t.zanre.join(",") : "",
        dubLang: jeSKCZ ? (langMatch.find(function(l) { return /^(CZ|SK)$/i.test(l); }) || '').toLowerCase() : ''
    };

    return streamObj;
}
// ===================================================================
// VLASTNÝ EXPRESS SERVER BEZ `getRouter` Z SDK
// ===================================================================
const app = express();
app.use(cors());
app.use(express.json()); 

// Maskovanie config segmentu v URL — base64 config obsahuje uid/pass/debrid kľúče,
// NESMIE sa dostať do logov. Nahradíme ho krátkym hashom.
function maskConfigVUrl(url) {
    // config je prvá časť cesty: /<config>/stream/... — base64url reťazec (A-Za-z0-9-_)
    const match = url.match(/^\/([A-Za-z0-9_-]{20,})(?=\/)/);
    if (!match) return url;
    const hash = crypto.createHash("sha1").update(match[1]).digest("hex").slice(0, 8);
    return url.replace(match[1], `cfg:${hash}`);
}

// Express 4 nechytá rejected promises v async handleroch — request by visel bez odpovede
// (Stremio by to videl ako timeout a retry-oval). Tento wrapper pošle chybu do error middlewaru.
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── PRECACHE ĎALŠEJ EPIZÓDY — trigger z /play (reálne začaté prehrávanie) ──
// Keď Stremio začne prehrávať CACHED epizódu (⚡), stiahne si jej /play URL.
// To je signál, že user naozaj pozerá — vtedy na pozadí pošleme interný request
// na streamy NASLEDUJÚCEJ epizódy (?precache=1), kde sa rozhodne, či treba
// začať sťahovať torrent do debridu (rovnaká cesta ako klik na ⏳ stream).
// Pôvodné ID seriálu poznáme cez precacheIdMap (hash → ID z posledného
// vyhľadávania). Rekurzia je ošetrená: request s precache=1 už nič nespúšťa.
function spustitPrecacheDalsejEpizody(userConfig, debridProvider, debridApiKey, hash, seria, epizoda, configSegment) {
    try {
        if (!userConfig || userConfig.precacheNextEpisode !== true || !debridProvider || !debridApiKey) return;
        const s = parseInt(seria, 10);
        const e = parseInt(epizoda, 10);
        if (!(s > 0) || !(e > 0)) return; // filmy (0:0) a specialy (S0) preskakujeme
        const povodneId = precacheIdMap.get(String(hash || '').toLowerCase());
        if (!povodneId || !/:\d+:\d+$/.test(povodneId)) {
            logInfo(`[PRECACHE] S${s}E${e}: preskočené (hash ${String(hash).slice(0, 12)}... nemáme ID, streamy sa možno hľadali pred reštartom)`);
            return;
        }
        const dalsiaEpizoda = e + 1;
        const showCast = povodneId.replace(/:\d+:\d+$/, '');
        const nextId = `${showCast}:${s}:${dalsiaEpizoda}`;
        const userKey = crypto.createHash('sha1').update(String(userConfig.user_id || userConfig.uid || '')).digest('hex').slice(0, 8);
        const precacheKluč = `${userKey}|${showCast}|${s}|${dalsiaEpizoda}`;
        const naposledy = precacheCasovac.get(precacheKluč) || 0;
        if (Date.now() - naposledy > PRECACHE_MIN_INTERVAL_MS) {
            precacheCasovac.set(precacheKluč, Date.now());
            // Občasné upratovanie mapy, nech nerastie donekonečna
            if (precacheCasovac.size > 200) {
                for (const [k, v] of precacheCasovac) {
                    if (Date.now() - v > PRECACHE_MIN_INTERVAL_MS * 2) precacheCasovac.delete(k);
                }
            }
            logInfo(`[PRECACHE] S${s}E${e} sa začína prehrávať → S${s}E${dalsiaEpizoda} (${nextId}): spúšťam na pozadí`);
            setImmediate(() => {
                axios.get(`http://127.0.0.1:${PORT}/${configSegment}/stream/series/${nextId}.json?precache=1`, {
                    timeout: 90000,
                    validateStatus: () => true
                }).then(r => {
                    const pocet = (r.data && Array.isArray(r.data.streams)) ? r.data.streams.length : '?';
                    logSuccess(`[PRECACHE] S${s}E${dalsiaEpizoda}: interný request hotový (HTTP ${r.status}, ${pocet} streamov)`);
                }).catch(e => {
                    logWarn(`[PRECACHE] S${s}E${dalsiaEpizoda}: interný request zlyhal: ${e.message}`);
                });
            });
        } else {
            logInfo(`[PRECACHE] S${s}E${dalsiaEpizoda}: preskočené (pre-cache bežal pred menej ako 30 min)`);
        }
    } catch (chyba) {
        logWarn(`[PRECACHE] trigger zlyhal: ${chyba.message}`);
    }
}

app.use((req, res, next) => {
    // Referer nesmie uniknút na CDN/debrid — URL obsahuje base64 config s
    // uid/pass/debrid kľúčmi usera. Bez tejto hlavičky by CDN videlo kľúče
    // v Referer hlavičke pri 302 redirecte (play/download).
    res.setHeader('Referrer-Policy', 'no-referrer');
    console.log(`\n======================================================`);
    console.log(`[${getTime()}] 🌍 [HTTP REQUEST] -> ${req.method} ${maskConfigVUrl(req.originalUrl)}`);
    console.log(`[${getTime()}] 📡 IP: ${req.ip} | User-Agent: ${req.headers['user-agent']?.substring(0, 50)}...`);
    next(); 
});

// --- Web UI ---
// --- API: SKTorrent Login Proxy ---
// In-memory rate limiting (bez dependency) — login proxy by sa dal zneužiť na
// brute-force SKTorrent účtov cez tento server. 20 pokusov / 10 min / IP.
const loginPokusy = new Map();
function skontrolujLoginRateLimit(ip) {
    const teraz = Date.now();
    const okno = 10 * 60 * 1000; // 10 min
    const zoznam = (loginPokusy.get(ip) || []).filter(t => teraz - t < okno);
    if (zoznam.length >= 20) {
        loginPokusy.set(ip, zoznam);
        return true; // limit dosiahnutý
    }
    zoznam.push(teraz);
    loginPokusy.set(ip, zoznam);
    // občasné upratovanie, nech mapa nerastie donekonečna
    if (loginPokusy.size > 1000) {
        for (const [k, v] of loginPokusy) {
            if (v.every(t => teraz - t >= okno)) loginPokusy.delete(k);
        }
    }
    return false;
}

app.post('/api/sktorrent-login', asyncRoute(async (req, res) => {
    if (skontrolujLoginRateLimit(req.ip || "unknown")) {
        return res.status(429).json({ error: 'Príliš veľa pokusov o prihlásenie, skús to neskôr.' });
    }
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Chýba meno alebo heslo' });
    }
    try {
        const loginRes = await axios({
            method: 'post',
            url: 'https://sktorrent.eu/torrent/login.php',
            data: `uid=${encodeURIComponent(username)}&pwd=${encodeURIComponent(password)}`,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
                'Origin': 'https://sktorrent.eu',
                'Referer': 'https://sktorrent.eu/torrent/'
            },
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 400
        });

        const setCookie = loginRes.headers['set-cookie'];
        if (!setCookie || !Array.isArray(setCookie) || setCookie.length === 0) {
            return res.status(401).json({ error: 'Nesprávne meno alebo heslo' });
        }

        let uid = '', pass = '';
        for (const cookie of setCookie) {
            if (cookie.startsWith('uid=')) uid = cookie.split(';')[0].substring(4);
            if (cookie.startsWith('pass=')) pass = cookie.split(';')[0].substring(5);
        }

        if (!uid || !pass) {
            return res.status(401).json({ error: 'Nesprávne meno alebo heslo' });
        }

        logSuccess(`SKTorrent login OK: ${username} (UID: ${uid})`);
        res.json({ uid, pass, username });
    } catch (error) {
        logError('SKTorrent login proxy error', error);
        res.status(500).json({ error: 'Chyba pri prihlasovaní k SKTorrent' });
    }
}));
app.get('/', (req, res) => {
    res.redirect(302, '/configure');
});

app.get(['/configure', '/:config/configure'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    let currentConfig = {};
    if (req.params.config) {
        try {
            currentConfig = decodeConfig(req.params.config) || {};
        } catch (e) {
            console.error("Chyba pri dekódovaní configu:", e);
        }
    }

    const getVal = (key) => currentConfig[key] ? currentConfig[key] : '';
    const getCheck = (key, defaultVal) => {
        if (currentConfig[key] !== undefined) return currentConfig[key] ? 'checked' : '';
        return defaultVal ? 'checked' : '';
    };
    const getSelect = (key, val, defaultVal) => {
        if (currentConfig[key] !== undefined) return currentConfig[key] === val ? 'selected' : '';
        return val === defaultVal ? 'selected' : '';
    };
    const hasArrVal = (key, val, defaultActive) => {
        const v = currentConfig[key];
        if (v === undefined) return defaultActive ? 'active' : '';
        if (Array.isArray(v)) return v.includes(val) ? 'active' : '';
        return String(v).split(',').includes(val) ? 'active' : '';
    };
    const getSortSelectVal = (idx) => {
        const sort = currentConfig.sort;
        if (sort && Array.isArray(sort) && sort[idx]) return sort[idx];
        if (sort && typeof sort === 'string') {
            try { const arr = JSON.parse(sort); if (arr[idx]) return arr[idx]; } catch(e) {}
        }
        return ['cached','quality','lang','seeds','size'][idx] || 'cached';
    };


    const html = `
    <!DOCTYPE html>
    <html lang="sk">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>TorrentSK</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0f09; color: #e0e0e0; display: flex; justify-content: center; padding: 30px 15px; }
            .container { background: #132210; padding: 0; border-radius: 12px; width: 100%; max-width: 500px; box-shadow: 0 8px 32px rgba(0,0,0,0.6); overflow: hidden; }
            .header { background: linear-gradient(135deg, #162f12 0%, #0d1f0a 100%); padding: 24px; text-align: center; border-bottom: 1px solid #2a4520; }
            .header h2 { font-size: 22px; font-weight: 700; background: linear-gradient(135deg, #76B83E, #9DE062); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
            .header p { font-size: 13px; color: #888; margin-top: 6px; }

            .section { border-bottom: 1px solid #2a4520; }
            .section:last-child { border-bottom: none; }
            .section-header { display: flex; align-items: center; gap: 10px; padding: 16px 20px 8px; font-size: 13px; font-weight: 600; color: #76B83E; text-transform: uppercase; letter-spacing: 0.5px; }
            .section-header .icon { font-size: 18px; }
            .section-desc { padding: 0 20px 12px; font-size: 12px; color: #666; }

            .field { padding: 8px 20px; }
            .field label { display: block; font-size: 12px; font-weight: 600; color: #aaa; margin-bottom: 4px; }
            .field input, .field select { width: 100%; padding: 10px 12px; background: #0d1a0b; border: 1px solid #2a4520; color: #e0e0e0; border-radius: 8px; font-size: 14px; outline: none; transition: border 0.2s; }
            .field input:focus, .field select:focus { border-color: #76B83E; }
            .field select { cursor: pointer; appearance: auto; }

            .checkbox-row { display: flex; align-items: center; gap: 10px; padding: 6px 20px; cursor: pointer; }
            .checkbox-row:hover { background: rgba(118,184,62,0.05); }
            .checkbox-row input[type="checkbox"] { width: 18px; height: 18px; accent-color: #76B83E; cursor: pointer; }
            .checkbox-row .label-text { font-size: 14px; color: #ccc; }
            .checkbox-row .label-desc { font-size: 11px; color: #666; margin-left: auto; }

            .chip-group { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 20px; }
            .chip { display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; background: #0d1a0b; border: 1px solid #2a4520; border-radius: 20px; font-size: 13px; color: #ccc; cursor: pointer; transition: all 0.2s; user-select: none; }
            .chip:hover { border-color: #76B83E; }
            .chip.active { border-color: #76B83E; color: #d4edc9; background: rgba(118,184,62,0.2); }

            .sort-row { display: flex; align-items: center; gap: 8px; padding: 6px 20px; }
            .sort-row .num { width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; background: #0d1a0b; border: 1px solid #2a4520; border-radius: 50%; font-size: 11px; color: #666; flex-shrink: 0; }
            .sort-row select { flex: 1; padding: 8px 10px; background: #0d1a0b; border: 1px solid #2a4520; color: #e0e0e0; border-radius: 8px; font-size: 13px; outline: none; cursor: pointer; }
            .sort-row select:focus { border-color: #76B83E; }
            .sort-btn { width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; background: #0d1a0b; border: 1px solid #2a4520; border-radius: 6px; color: #666; cursor: pointer; font-size: 14px; flex-shrink: 0; transition: all 0.2s; }
            .sort-btn:hover { border-color: #76B83E; color: #76B83E; }
            .sort-btn:disabled { opacity: 0.3; cursor: not-allowed; }
            .sort-toggle { width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #76B83E; cursor: pointer; font-size: 16px; flex-shrink: 0; padding: 0; transition: opacity 0.2s; }
            .sort-toggle:hover { opacity: 0.7; }

            .btn-primary { width: calc(100% - 40px); margin: 16px 20px; padding: 12px; background: linear-gradient(135deg, #76B83E, #5A9A2E); color: white; border: none; font-size: 15px; font-weight: 600; border-radius: 8px; cursor: pointer; transition: all 0.2s; }
            .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 4px 15px rgba(118,184,62,0.4); }

            #result-box { display: none; margin: 0 20px 20px; padding: 20px; background: rgba(118,184,62,0.06); border: 1px solid #76B83E; border-radius: 10px; text-align: center; }
            #result-box p { font-size: 12px; color: #76B83E; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
            #generated-url { width: 100%; font-size: 12px; font-family: 'Courier New', monospace; padding: 10px; margin-bottom: 14px; background: #0d1a0b; color: #e0e0e0; border: 1px solid #2a4520; border-radius: 8px; word-break: break-all; resize: none; height: 52px; outline: none; transition: border 0.2s; }
            #generated-url:focus { border-color: #76B83E; }
            .btn-sm { padding: 8px 16px; border: 1px solid #2a4520; border-radius: 8px; font-size: 13px; cursor: pointer; margin: 3px; transition: all 0.2s; }
            .btn-copy { background: #0d1a0b; color: #ccc; }
            .btn-copy:hover { background: rgba(118,184,62,0.2); border-color: #76B83E; color: #fff; }
            .btn-install { background: linear-gradient(135deg, #76B83E, #5A9A2E); color: white; border: none; }
            .btn-install:hover { transform: translateY(-1px); box-shadow: 0 4px 15px rgba(118,184,62,0.4); }
            .lang-btn { background:none; border:1px solid #2a4520; border-radius:6px; padding:4px 10px; font-size:13px; color:#ccc; cursor:pointer; transition:all 0.2s; }
            .lang-btn:hover { border-color: #76B83E; }
            .lang-btn.active { border-color: #76B83E; background: rgba(118,184,62,0.2); color:#d4edc9; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <div style="display:flex;align-items:stretch;justify-content:space-between;gap:12px;">
                    <div style="flex:0 0 auto;display:flex;flex-direction:column;justify-content:center;gap:4px;min-width:36px;">
                        <button class="lang-btn active" data-lang-btn="sk" onclick="setLang('sk')" style="display:block;width:100%;">🇸🇰</button>
                        <button class="lang-btn" data-lang-btn="en" onclick="setLang('en')" style="display:block;width:100%;">🇬🇧</button>
                    </div>
                    <div style="flex:1;text-align:center;display:flex;flex-direction:column;justify-content:center;">
                        <h2 data-i18n="title">TorrentSK</h2>
                        <p data-i18n="subtitle" style="font-size:13px;color:#888;margin-top:4px;">Nastav si preferencie a vygeneruj inštalačný odkaz</p>
                    </div>
                    <div style="flex:0 0 auto;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:8px;min-width:36px;">
                        <a href="https://github.com/Judzim/Cz-SkTorrent-Stremio-Addon" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;color:#888;transition:color 0.2s;margin-left:-2px;" title="GitHub">
                            <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
                        </a>
                        <a href="https://ko-fi.com/judzim" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;transition:opacity 0.2s;" title="Ko-fi">
                            <img src="/ko-fi-logo.jpg" alt="Ko-fi" style="width:95%;height:95%;object-fit:contain;border-radius:3px;">
                        </a>
                    </div>
                </div>
            </div>

            <!-- 🔌 Connection -->
            <div class="section">
                <div class="section-header"><span class="icon">🔌</span> <span data-i18n="section.connection">Connection</span></div>
                <div class="section-desc" data-i18n="desc.connection">Prihlasovacie údaje a API kľúče</div>
                
                <!-- Najprv výber služby -->
                <div class="field" id="debridServiceField">
                    <label data-i18n="label.debrid">Debrid služba</label>
                    <select id="debridProvider" onchange="toggleDebridFields()">
                        <option value="" ${getSelect('debridProvider','','') || (!currentConfig.debridProvider && !currentConfig.torbox ? 'selected' : '')} data-i18n="debrid.choose">— Vyber —</option>
                        <option value="p2p" data-i18n="debrid.p2p">Klasický torrent (P2P)</option>
                        <option value="torbox" ${getSelect('debridProvider','torbox','') || (currentConfig.torbox && !currentConfig.debridProvider ? 'selected' : '')}>TorBox</option>
                        <option value="realdebrid" ${getSelect('debridProvider','realdebrid','')}>Real-Debrid</option>
                    </select>
                </div>

                <!-- SKTorrent login — vždy viditeľný (zrýchli vyhľadávanie aj v debrid móde) -->
                <div id="sktorrentSection" style="display:block;padding-left:16px;border-left:2px solid #333;margin:0 20px 8px;">
                <div class="field" id="loginFields" style="display:block;">
                    <label>🔑 <span data-i18n="label.sktorrentLogin">Prihlásiť sa na SKTorrent</span> <span style="color:#666;font-weight:400;" data-i18n-optional="label.sktorrentLogin.optional">(voliteľné)</span></label>
                    <div style="display:flex;gap:8px;flex-wrap:wrap;">
                        <input type="text" id="loginUser" data-i18n-placeholder="login.uid.placeholder" placeholder="Používateľské meno" style="flex:1;min-width:120px;">
                        <input type="password" id="loginPass" data-i18n-placeholder="login.pass.placeholder" placeholder="Heslo" style="flex:1;min-width:120px;">
                    </div>
                    <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;">
                        <button id="loginBtn" onclick="loginToSKTorrent()" style="padding:8px 16px;background:linear-gradient(135deg,#76B83E,#5A9A2E);color:white;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;" data-i18n="button.login">Prihlásiť sa</button>
                        <a href="https://sktorrent.eu/torrent/account.php" target="_blank" rel="noopener" style="padding:8px 16px;background:#333;color:#999;border:none;border-radius:8px;font-size:13px;font-weight:400;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;" data-i18n="button.register">Registrovať sa</a>
                    </div>
                    <div id="loginStatus" style="font-size:12px;margin-top:6px;"></div>
                </div>
                
                <div id="manualSection">
                <!-- Hidden uid/pass fields (vyplnia sa automaticky po prihlásení) -->
                <div id="hiddenCredentials" style="display:none;">
                    <input type="hidden" id="uid" value="">
                    <input type="hidden" id="pass" value="">
                </div>
                
                <!-- Manual fallback - ak niekto chce rucne zadat uid/pass -->
                <div style="padding:0 0 8px;">
                    <a href="#" onclick="toggleManualFields(event)" style="font-size:12px;color:#666;text-decoration:none;" data-i18n="link.manual">▶ Manuálne zadať UID a PASS</a>
                </div>
                <div id="manualFields" style="display:none;">
                    <div class="field">
                        <label data-i18n="label.uid">SKTorrent UID</label>
                        <input type="text" id="manualUid" data-i18n-placeholder="uid.placeholder" placeholder="Napr. 123987" value="${getVal('uid')}">
                        <div style="font-size:11px;color:#666;margin-top:2px;" data-i18n="uid.help">ℹ️ Nájdeš v cookies po prihlásení na sktorrent.eu</div>
                    </div>
                    <div class="field">
                        <label data-i18n="label.pass">SKTorrent pass</label>
                        <input type="password" id="manualPass" data-i18n-placeholder="pass.placeholder" placeholder="Tvoj pass" value="${getVal('pass')}">
                        <div style="font-size:11px;color:#666;margin-top:2px;" data-i18n="pass.help">ℹ️ Nájdeš v cookies po prihlásení na sktorrent.eu</div>
                    </div>
                </div>
                </div>
                </div>
                <div class="field" id="torboxField" style="display:${currentConfig.debridProvider === 'torbox' || (!currentConfig.debridProvider && currentConfig.torbox) ? '' : 'none'};">
                    <label data-i18n="label.torbox">TorBox API kľúč</label>
                    <input type="text" id="torbox" data-i18n-placeholder="torbox.placeholder" placeholder="TorBox token" value="${getVal('torbox')}">
                    <div style="font-size:11px;color:#666;margin-top:2px;"><a href="https://torbox.app/settings?section=account" target="_blank" rel="noopener" style="color:#76B83E;text-decoration:none;" data-i18n-link="torbox.help">🔗 torbox.app/settings?section=account</a></div>
                </div>
                <div class="field" id="realdebridField" style="display:${currentConfig.debridProvider === 'realdebrid' ? '' : 'none'};">
                    <label data-i18n="label.realdebrid">Real-Debrid API kľúč</label>
                    <input type="text" id="realdebrid" data-i18n-placeholder="realdebrid.placeholder" placeholder="Real-Debrid API token" value="${getVal('realdebrid')}">
                    <div style="font-size:11px;color:#666;margin-top:2px;"><a href="https://real-debrid.com/devices" target="_blank" rel="noopener" style="color:#76B83E;text-decoration:none;" data-i18n-link="realdebrid.help">🔗 real-debrid.com/devices</a></div>
                </div>
                <div class="field">
                    <label><span data-i18n="label.tmdb">TMDB API kľúč</span> <span style="color:#666;font-weight:400;" data-i18n-optional="label.tmdb.optional">(voliteľné)</span></label>
                    <input type="text" id="tmdb" data-i18n-placeholder="tmdb.placeholder" placeholder="TMDB token" value="${getVal('tmdb')}">
                    <div style="font-size:11px;color:#666;margin-top:2px;"><a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener" style="color:#76B83E;text-decoration:none;" data-i18n-link="tmdb.help">🔗 themoviedb.org/settings/api</a></div>
                </div>
                <div class="field" style="padding-bottom:16px;">
                    <label><span data-i18n="label.tvdb">TVDB API kľúč</span> <span style="color:#666;font-weight:400;" data-i18n-optional="label.tvdb.optional">(voliteľné)</span></label>
                    <input type="text" id="tvdb" data-i18n-placeholder="tvdb.placeholder" placeholder="TVDB token" value="${getVal('tvdb')}">
                    <div style="font-size:11px;color:#666;margin-top:2px;"><a href="https://thetvdb.com/dashboard/account/apikey" target="_blank" rel="noopener" style="color:#76B83E;text-decoration:none;" data-i18n-link="tvdb.help">🔗 thetvdb.com/dashboard/account/apikey</a></div>
                </div>
            </div>

            <!-- 🌐 Language & Display -->
            <div class="section">
                <div class="section-header"><span class="icon">🌐</span> <span data-i18n="section.display">Language &amp; Display</span></div>
                <div class="section-desc" data-i18n="desc.display">Nastavenia jazyka a zobrazenia výsledkov</div>

                <div style="padding: 8px 20px 4px;"><label style="font-size:12px;font-weight:600;color:#aaa;" data-i18n="label.preferLangs">Preferované jazyky</label></div>
                <div class="chip-group" id="langChips">
                    <span class="chip ${hasArrVal('lang','sk',true)}" data-lang="sk" onclick="toggleChip(this)">🇸🇰 SK</span>
                    <span class="chip ${hasArrVal('lang','cz',true)}" data-lang="cz" onclick="toggleChip(this)">🇨🇿 CZ</span>
                    <span class="chip ${hasArrVal('lang','en',false)}" data-lang="en" onclick="toggleChip(this)">🇬🇧 EN</span>
                    <span class="chip ${hasArrVal('lang','multi',false)}" data-lang="multi" onclick="toggleChip(this)">🌍 Multi</span>
                </div>

                <div style="padding: 8px 20px 4px;"><label style="font-size:12px;font-weight:600;color:#aaa;" data-i18n="label.showInStream">Zobraziť v názve streamu</label></div>
                <div class="chip-group" id="showChips" style="padding-bottom:12px;">
                    <span class="chip ${hasArrVal('show','title',true)}" data-show="title" onclick="toggleChip(this)"><span data-i18n="chip.title">Názov</span></span>
                    <span class="chip ${hasArrVal('show','quality',true)}" data-show="quality" onclick="toggleChip(this)"><span data-i18n="chip.quality">Kvalita</span></span>
                    <span class="chip ${hasArrVal('show','size',true)}" data-show="size" onclick="toggleChip(this)"><span data-i18n="chip.size">Veľkosť</span></span>
                    <span class="chip ${hasArrVal('show','lang',true)}" data-show="lang" onclick="toggleChip(this)"><span data-i18n="chip.lang">Jazyk</span></span>
                    <span class="chip ${hasArrVal('show','seeds',true)}" data-show="seeds" onclick="toggleChip(this)"><span data-i18n="chip.seeds">Seedery</span></span>
                </div>
            </div>

            <!-- 🎚️ Quality & Filters -->
            <div class="section">
                <div class="section-header"><span class="icon">🎚️</span> <span data-i18n="section.filters">Quality &amp; Filters</span></div>
                <div class="section-desc" data-i18n="desc.filters">Obmedz kvalitu, veľkosť a počet výsledkov</div>

                <div class="checkbox-row" id="cachedOnlyRow" onclick="toggleCheckbox('cachedOnly', event)">
                    <input type="checkbox" id="cachedOnly" onchange="aktualizujCachedOnlyWarning()" ${getCheck('cachedOnly', false)}>
                    <span class="label-text" data-i18n="checkbox.cached">Cached Only</span>
                    <span class="label-desc" data-i18n="checkbox.cached.desc">Len cachované streamy</span>
                </div>
                <div id="cachedOnlyRdWarning" style="display:none;margin:-2px 20px 12px;padding:8px 12px;background:rgba(255,183,77,0.1);border:1px solid rgba(255,183,77,0.35);border-radius:8px;font-size:12px;line-height:1.5;color:#ffb74d;" data-i18n="checkbox.cached.rdWarning">⚠️ Pri Real-Debrid je Cached Only nespoľahlivé: RD nemá API na kontrolu cache. ⚡ označuje len torrenty, ktoré už stiahol niekto cez tento addon, filter môže skryť hrateľné streamy.</div>
                <div class="checkbox-row" id="precacheRow" onclick="toggleCheckbox('precacheNextEpisode', event)">
                    <input type="checkbox" id="precacheNextEpisode" ${getCheck('precacheNextEpisode', false)}>
                    <span class="label-text" data-i18n="checkbox.precache">Pre-cache ďalšej epizódy</span>
                    <span class="label-desc" data-i18n="checkbox.precache.desc">Seriály: na pozadí začať sťahovať ďalšiu epizódu</span>
                </div>
                <div style="padding: 8px 20px 4px;"><label style="font-size:12px;font-weight:600;color:#aaa;" data-i18n="label.videoQuality">Kvalita videa</label></div>
                <div class="chip-group" id="hdrChips" style="padding-bottom:12px;">
                    <span class="chip ${hasArrVal('hdr','hdr',true)}" data-hdr="hdr" onclick="toggleChip(this)">HDR</span>
                    <span class="chip ${hasArrVal('hdr','dv',true)}" data-hdr="dv" onclick="toggleChip(this)">Dolby Vision</span>
                    <span class="chip ${hasArrVal('hdr','hevc',true)}" data-hdr="hevc" onclick="toggleChip(this)">HEVC</span>
                    <span class="chip ${hasArrVal('hdr','atmos',true)}" data-hdr="atmos" onclick="toggleChip(this)">Atmos</span>
                </div>

                <div style="padding: 8px 20px 4px;"><label style="font-size:12px;font-weight:600;color:#aaa;" data-i18n="label.filter18">18+ filter</label></div>
                <div class="chip-group" id="adultChips" style="padding-bottom:4px;">
                    <span class="chip ${hasArrVal('adult','hide',true)}" data-adult="hide" onclick="toggleChip(this)"><span data-i18n="chip.hide18">Skryť 18+ obsah</span></span>
                </div>

                <div style="padding: 8px 20px 4px;"><label style="font-size:12px;font-weight:600;color:#aaa;" data-i18n="label.sourceType">🎞️ Typ zdroja</label></div>
                <div class="chip-group" id="sourceChips" style="padding-bottom:12px;">
                    <span class="chip ${hasArrVal('source','webdl',true)}" data-source="webdl" onclick="toggleChip(this)">WEB-DL</span>
                    <span class="chip ${hasArrVal('source','bluray',true)}" data-source="bluray" onclick="toggleChip(this)">BluRay</span>
                    <span class="chip ${hasArrVal('source','hdtv',true)}" data-source="hdtv" onclick="toggleChip(this)">HDTV</span>
                    <span class="chip ${hasArrVal('source','dvdrip',true)}" data-source="dvdrip" onclick="toggleChip(this)">DVDRip</span>
                    <span class="chip ${hasArrVal('source','webrip',true)}" data-source="webrip" onclick="toggleChip(this)">WEBRip</span>
                    <span class="chip ${hasArrVal('source','hdrip',true)}" data-source="hdrip" onclick="toggleChip(this)">HDRip</span>
                    <span class="chip ${hasArrVal('source','ppv',true)}" data-source="ppv" onclick="toggleChip(this)">PPV</span>
                    <span class="chip ${hasArrVal('source','remux',true)}" data-source="remux" onclick="toggleChip(this)">Remux</span>
                    <span class="chip ${hasArrVal('source','cam',true)}" data-source="cam" onclick="toggleChip(this)">CAM / KINO</span>
                    <span class="chip ${hasArrVal('source','screener',true)}" data-source="screener" onclick="toggleChip(this)">Screener</span>
                    <span class="chip ${hasArrVal('source','vodrip',true)}" data-source="vodrip" onclick="toggleChip(this)">VODRip</span>
                    <span class="chip ${hasArrVal('source','tvrip',true)}" data-source="tvrip" onclick="toggleChip(this)">TVRip</span>
                </div>
                <div style="padding: 0 20px 8px;font-size:11px;color:#555;" data-i18n="hint.allSources">Prázdne = všetky zdroje</div>

                <div style="padding: 8px 20px 4px;"><label style="font-size:12px;font-weight:600;color:#aaa;" data-i18n="label.resolution">Rozlíšenie</label></div>
                <div class="chip-group" id="resChips" style="padding-bottom:4px;">
                    <span class="chip ${hasArrVal('res','2160p',true)}" data-res="2160p" onclick="toggleChip(this)">4K</span>
                    <span class="chip ${hasArrVal('res','1080p',true)}" data-res="1080p" onclick="toggleChip(this)">1080p</span>
                    <span class="chip ${hasArrVal('res','720p',true)}" data-res="720p" onclick="toggleChip(this)">720p</span>
                    <span class="chip ${hasArrVal('res','sd',true)}" data-res="sd" onclick="toggleChip(this)">SD</span>
                </div>
                <div style="padding: 0 20px 8px;font-size:11px;color:#555;" data-i18n="hint.allResolutions">Prázdne = všetky rozlíšenia</div>

                <div class="field">
                    <label data-i18n="label.maxResults">Maximálny počet výsledkov</label>
                    <select id="maxResults">
                        <option value="0" ${getSelect('maxResults', '0', '0')} data-i18n="opt.unlimited">Neobmedzene</option>
                        <option value="5" ${getSelect('maxResults', '5', '0')}>5</option>
                        <option value="10" ${getSelect('maxResults', '10', '0')}>10</option>
                        <option value="20" ${getSelect('maxResults', '20', '0')}>20</option>
                        <option value="50" ${getSelect('maxResults', '50', '0')}>50</option>
                    </select>
                </div>

                <div class="field">
                    <label data-i18n="label.maxPerRes">Max. na rozlíšenie</label>
                    <select id="maxPerRes">
                        <option value="0" ${getSelect('maxPerRes', '0', '0')}><span data-i18n="opt.unlimited">Neobmedzene</span></option>
                        <option value="1" ${getSelect('maxPerRes', '1', '0')}>1</option>
                        <option value="2" ${getSelect('maxPerRes', '2', '0')}>2</option>
                        <option value="3" ${getSelect('maxPerRes', '3', '0')}>3</option>
                        <option value="5" ${getSelect('maxPerRes', '5', '0')}>5</option>
                        <option value="10" ${getSelect('maxPerRes', '10', '0')}>10</option>
                    </select>
                </div>

                <div class="field">
                    <label data-i18n="label.maxSize">Max. veľkosť súboru</label>
                    <select id="maxSize">
                        <option value="0" ${getSelect('maxSize', '0', '0')}><span data-i18n="opt.unlimited">Neobmedzene</span></option>
                        <option value="2" ${getSelect('maxSize', '2', '0')}>2 GB</option>
                        <option value="4" ${getSelect('maxSize', '4', '0')}>4 GB</option>
                        <option value="8" ${getSelect('maxSize', '8', '0')}>8 GB</option>
                        <option value="16" ${getSelect('maxSize', '16', '0')}>16 GB</option>
                        <option value="50" ${getSelect('maxSize', '50', '0')}>50 GB</option>
                    </select>
                </div>

                <div class="field" style="padding-bottom:16px;">
                    <label data-i18n="label.minSeeds">Minimálny počet seedov</label>
                    <input type="number" id="minSeeds" value="${getVal('minSeeds') || '0'}" min="0" style="width:100px;">
                </div>
            </div>

            <!-- 📑 Katalógy v Stremio -->
            <div class="section">
                <div class="section-header"><span class="icon">📑</span> <span data-i18n="section.catalogs">Katalógy v Stremio</span></div>
                <div class="section-desc" data-i18n="desc.catalogs">Nastav poradie a zapni/vypni kategórie (● zapnuté, ○ vypnuté)</div>

                <div id="catalogOrders">
                    <!-- Dynamicky vytvorene cez JS -->
                </div>

                <!-- 👶 Vek pre detský obsah -->
                <div style="margin: 12px 20px 6px 20px; padding: 10px 14px; background: rgba(118, 184, 62, 0.08); border: 1px solid #2a4520; border-radius: 8px;">
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
                        <label style="font-size:13px; color:#e0e0e0; font-weight:600; display:flex; align-items:center; gap:6px; margin-bottom:0;">
                            <span>👶</span> <span data-i18n="label.kidsAge">Vek pre kategóriu Pre deti:</span>
                        </label>
                        <select id="kidsAge" style="padding:6px 12px; background:#0d1a0b; border:1px solid #76B83E; color:#76B83E; border-radius:6px; font-weight:bold; font-size:13px; outline:none; cursor:pointer;">
                            <option value="6" ${getSelect('kidsAge', '6', '12')}>👶 Do 6 rokov (Predškoláci)</option>
                            <option value="12" ${getSelect('kidsAge', '12', '12')}>🧒 Do 12 rokov (Školáci)</option>
                            <option value="16" ${getSelect('kidsAge', '16', '12')}>🧑 Do 16 rokov (Mládež)</option>
                            <option value="all" ${getSelect('kidsAge', 'all', '12')}>⭐ Bez obmedzenia</option>
                        </select>
                    </div>
                    <div style="font-size:11px; color:#888; margin-top:5px; line-height:1.4;" data-i18n="desc.kidsAge">
                        Filtruje rozprávky a animáky podľa veku dieťaťa (podobne ako detský profil na Netflixe alebo YouTube Kids).
                    </div>
                </div>
            </div>

            <!-- 📊 Sort Order -->
            <div class="section">
                <div class="section-header"><span class="icon">📊</span> <span data-i18n="section.sort">Sort Order</span></div>
                <div class="section-desc" data-i18n="desc.sort">Priorita radenia výsledkov</div>

                <div id="sortOrders">
                    <!-- Dynamicky vytvorene cez JS -->
                </div>
            </div>

            <button class="btn-primary" onclick="generateLink()"><span data-i18n="button.generate">✨ Vygenerovať odkaz</span></button>

            <div id="result-box">
                <p data-i18n="result.title">Tvoj inštalačný odkaz</p>
                <textarea id="generated-url" readonly></textarea>
                <button class="btn-sm btn-copy" onclick="copyUrl()"><span data-i18n="button.copy">📋 Kopírovať</span></button>
                <button class="btn-sm btn-install" onclick="openStremio()"><span data-i18n="button.install">🚀 Inštalovať</span></button>
            </div>
        </div>

        <script>
            // SORT_OPTIONS = poradie aj identita riadkov; select neni potrebný
            var SORT_OPTIONS = ['cached', 'quality', 'lang', 'seeds', 'size'];
            var SORT_LABELS = { cached: 'Cached', quality: 'Rozlíšenie', lang: 'Jazyk', seeds: 'Seedy', size: 'Veľkosť' };
            var ALL_CATALOG_IDS = [
                'skt_movies_trending',
                'skt_series_popular',
                'skt_kids',
                'skt_kids_series',
                'skt_sport',
                'skt_docs',
                'skt_movies_popular',
                'skt_series_new',
                'skt_movies_new'
            ];
            var CATALOG_LABELS = {
                skt_movies_trending: '🔥 Dnes populárne filmy',
                skt_series_popular: '📺 Populárne seriály',
                skt_kids: '👶 Pre deti (Rozprávky a filmy)',
                skt_kids_series: '🧸 Detské seriály',
                skt_sport: '🏁 Šport',
                skt_docs: '🌍 Dokumenty',
                skt_movies_popular: '🎬 Najsťahovanejšie filmy',
                skt_series_new: '✨ Najnovšie seriály',
                skt_movies_new: '🆕 Najnovšie filmy'
            };
            var CURR_LANG = localStorage.getItem('sktorrent_lang') || 'sk';

            var I18N = {
                sk: {
                    'title': 'TorrentSK',
                    'subtitle': 'Nastav si preferencie a vygeneruj inštalačný odkaz',
                    'section.connection': 'Pripojenie',
                    'desc.connection': 'Prihlasovacie údaje a API kľúče',
                    'label.uid': 'SKTorrent UID',
                    'uid.help': 'ℹ️ Nájdeš v cookies po prihlásení na sktorrent.eu',
                    'uid.placeholder': 'Napr. 123987',
                    'label.pass': 'SKTorrent pass',
                    'pass.help': 'ℹ️ Nájdeš v cookies po prihlásení na sktorrent.eu',
                    'pass.placeholder': 'Tvoj pass',
                    'label.debrid': 'Debrid služba',
                    'debrid.choose': '— Vyber —',
                    'debrid.p2p': 'Klasický torrent (P2P)',
                    'label.realdebrid': 'Real-Debrid API kľúč',
                    'realdebrid.placeholder': 'Real-Debrid API token',
                    'realdebrid.help': '🔗 real-debrid.com/devices',
                    'label.torbox': 'TorBox API kľúč',
                    'torbox.help': '🔗 https://torbox.app/settings?section=account',
                    'torbox.placeholder': 'TorBox token',
                    'label.tmdb': 'TMDB API kľúč',
                    'label.tmdb.optional': '(voliteľné)',
                    'tmdb.help': '🔗 https://www.themoviedb.org/settings/api',
                    'tmdb.placeholder': 'TMDB token',
                    'label.tvdb': 'TVDB API kľúč',
                    'label.tvdb.optional': '(voliteľné)',
                    'label.sktorrentLogin.optional': '(voliteľné)',
                    'tvdb.help': '🔗 https://thetvdb.com/dashboard/account/apikey',
                    'tvdb.placeholder': 'TVDB token',
                    'section.display': 'Jazyk a zobrazenie',
                    'desc.display': 'Nastavenia jazyka a zobrazenia výsledkov',
                    'label.preferLangs': 'Preferované jazyky',
                    'label.showInStream': 'Zobraziť v názve streamu',
                    'chip.title': 'Názov',
                    'chip.quality': 'Kvalita',
                    'chip.size': 'Veľkosť',
                    'chip.lang': 'Jazyk',
                    'chip.seeds': 'Seedery',
                    'section.filters': 'Kvalita a filtre',
                    'desc.filters': 'Obmedz kvalitu, veľkosť a počet výsledkov',
                    'checkbox.cached': 'Cached Only',
                    'checkbox.cached.desc': 'Len cachované streamy',
                    'checkbox.cached.rdWarning': '⚠️ Pri Real-Debrid je Cached Only nespoľahlivé: RD nemá API na kontrolu cache. ⚡ označuje len torrenty, ktoré už stiahol niekto cez tento addon, filter môže skryť hrateľné streamy.',
                    'checkbox.precache': 'Pre-cache ďalšej epizódy',
                    'checkbox.precache.desc': 'Seriály: po otvorení epizódy začni na pozadí sťahovať ďalšiu (ak nie je cached)',
                    'label.videoQuality': 'Kvalita videa',
                    'label.filter18': '18+ filter',
                    'chip.hide18': 'Skryť 18+ obsah',
                    'label.sourceType': '🎞️ Typ zdroja',
                    'hint.allSources': 'Prázdne = všetky zdroje',
                    'label.resolution': 'Rozlíšenie',
                    'hint.allResolutions': 'Prázdne = všetky rozlíšenia',
                    'label.maxResults': 'Maximálny počet výsledkov',
                    'opt.unlimited': 'Neobmedzene',
                    'label.maxPerRes': 'Max. na rozlíšenie',
                    'label.maxSize': 'Max. veľkosť súboru',
                    'label.minSeeds': 'Minimálny počet seedov',
                    'section.catalogs': 'Katalógy v Stremio',
                    'desc.catalogs': 'Nastav poradie a zapni/vypni katalógy na domovskej obrazovke (● zapnuté, ○ vypnuté)',
                    'cat.skt_movies_trending': '🔥 Dnes populárne filmy',
                    'cat.skt_series_popular': '📺 Populárne seriály',
                    'cat.skt_kids': '👶 Pre deti (Rozprávky a filmy)',
                    'cat.skt_kids_series': '🧸 Detské seriály',
                    'cat.skt_sport': '🏁 Šport',
                    'cat.skt_docs': '🌍 Dokumenty',
                    'cat.skt_movies_popular': '🎬 Najsťahovanejšie filmy',
                    'cat.skt_series_new': '✨ Najnovšie seriály',
                    'cat.skt_movies_new': '🆕 Najnovšie filmy',
                    'label.kidsAge': 'Vek pre kategóriu Pre deti:',
                    'desc.kidsAge': 'Filtruje rozprávky a animáky podľa veku dieťaťa (podobne ako detský profil na Netflixe alebo YouTube Kids).',
                    'desc.sort': 'Priorita radenia výsledkov',
                    'button.generate': '✨ Vygenerovať odkaz',
                    'result.title': 'Tvoj inštalačný odkaz',
                    'button.copy': '📋 Kopírovať',
                    'button.install': '🚀 Inštalovať',
                    'alert.fillUidPass': 'Pre P2P režim vyplň SKTorrent UID a PASS, alebo vyber TorBox/Real-Debrid.',
                    'alert.codeError': 'Chyba pri generovaní kódu.',
                    'button.copied': 'Skopírované!',
                    'button.copyIdle': 'Kopírovať',
                    'sort.toggleOn': 'Klikni pre vypnutie',
                    'sort.toggleOff': 'Klikni pre zapnutie',
                    'sort.cached': 'Cached',
                    'sort.quality': 'Rozlíšenie',
                    'sort.lang': 'Jazyk',
                    'sort.seeds': 'Seedy',
                    'sort.size': 'Veľkosť',
                    'label.sktorrentLogin': 'Prihlásiť sa na SKTorrent',
                    'login.uid.placeholder': 'Používateľské meno',
                    'login.pass.placeholder': 'Heslo',
                    'button.login': 'Prihlásiť sa',
                    'button.register': 'Registrovať sa',
                    'button.loggingIn': 'Prihlasujem...',
                    'link.manual': '▶ Manuálne zadať UID a PASS',
                    'link.manualHide': '▼ Skryť manuálne polia',
                    'lang.sk': 'Slovenčina',
                    'lang.en': 'English',
                    'section.sort': 'Zoradenie',
                },
                en: {
                    'title': 'TorrentSK',
                    'subtitle': 'Configure your preferences and generate install link',
                    'section.sort': 'Sort Order',
                    'section.connection': 'Connection',
                    'desc.connection': 'Login credentials and API keys',
                    'label.uid': 'SKTorrent UID',
                    'uid.help': 'ℹ️ Found in cookies after logging in at sktorrent.eu',
                    'uid.placeholder': 'e.g. 123987',
                    'label.pass': 'SKTorrent pass',
                    'pass.help': 'ℹ️ Found in cookies after logging in at sktorrent.eu',
                    'pass.placeholder': 'Your pass',
                    'label.debrid': 'Debrid Service',
                    'debrid.choose': '— Choose —',
                    'debrid.p2p': 'Classic torrent (P2P)',
                    'label.realdebrid': 'Real-Debrid API Key',
                    'realdebrid.placeholder': 'Real-Debrid API token',
                    'realdebrid.help': '🔗 real-debrid.com/devices',
                    'label.torbox': 'TorBox API Key',
                    'torbox.help': '🔗 https://torbox.app/settings?section=account',
                    'torbox.placeholder': 'TorBox token',
                    'label.tmdb': 'TMDB API Key',
                    'label.tmdb.optional': '(optional)',
                    'tmdb.help': '🔗 https://www.themoviedb.org/settings/api',
                    'tmdb.placeholder': 'TMDB token',
                    'label.tvdb': 'TVDB API Key',
                    'label.tvdb.optional': '(optional)',
                    'label.sktorrentLogin.optional': '(optional)',
                    'tvdb.help': '🔗 https://thetvdb.com/dashboard/account/apikey',
                    'tvdb.placeholder': 'TVDB token',
                    'section.display': 'Language & Display',
                    'desc.display': 'Language and stream display settings',
                    'label.preferLangs': 'Preferred languages',
                    'label.showInStream': 'Show in stream name',
                    'chip.title': 'Title',
                    'chip.quality': 'Quality',
                    'chip.size': 'Size',
                    'chip.lang': 'Language',
                    'chip.seeds': 'Seeders',
                    'section.filters': 'Quality & Filters',
                    'desc.filters': 'Limit quality, size, and number of results',
                    'checkbox.cached': 'Cached Only',
                    'checkbox.cached.desc': 'Cached streams only',
                    'checkbox.cached.rdWarning': '⚠️ With Real-Debrid the Cached Only filter is unreliable: RD has no cache-check API, ⚡ only marks torrents already downloaded through this addon, so it may hide playable streams.',
                    'checkbox.precache': 'Pre-cache next episode',
                    'checkbox.precache.desc': 'Series: when opening an episode, start downloading the next one in background (if not cached)',
                    'label.videoQuality': 'Video quality',
                    'label.filter18': '18+ filter',
                    'chip.hide18': 'Hide 18+ content',
                    'label.sourceType': '🎞️ Source type',
                    'hint.allSources': 'Empty = all sources',
                    'label.resolution': 'Resolution',
                    'hint.allResolutions': 'Empty = all resolutions',
                    'label.maxResults': 'Max results',
                    'opt.unlimited': 'Unlimited',
                    'label.maxPerRes': 'Max per resolution',
                    'label.maxSize': 'Max file size',
                    'label.minSeeds': 'Minimum seeders',
                    'section.catalogs': 'Stremio Catalogs',
                    'desc.catalogs': 'Set catalog order and toggle categories on/off (● enabled, ○ disabled)',
                    'cat.skt_movies_trending': '🔥 Trending Movies Today',
                    'cat.skt_series_popular': '📺 Popular Series',
                    'cat.skt_kids': '👶 Kids (Cartoons & Movies)',
                    'cat.skt_kids_series': '🧸 Kids Series',
                    'cat.skt_sport': '🏁 Sports',
                    'cat.skt_docs': '🌍 Documentaries',
                    'cat.skt_movies_popular': '🎬 Most Downloaded Movies',
                    'cat.skt_series_new': '✨ Newest Series',
                    'cat.skt_movies_new': '🆕 Newest Movies',
                    'label.kidsAge': 'Age rating for Kids category:',
                    'desc.kidsAge': 'Filters cartoons, animations and series according to child age (similar to Netflix Kids or YouTube Kids profile).',
                    'desc.sort': 'Result sorting priority',
                    'button.generate': '✨ Generate link',
                    'result.title': 'Your install link',
                    'button.copy': '📋 Copy',
                    'button.install': '🚀 Install',
                    'alert.fillUidPass': 'For P2P mode fill SKTorrent UID and PASS, or choose TorBox/Real-Debrid.',
                    'alert.codeError': 'Error generating code.',
                    'button.copied': 'Copied!',
                    'button.copyIdle': 'Copy',
                    'sort.toggleOn': 'Click to disable',
                    'sort.toggleOff': 'Click to enable',
                    'sort.cached': 'Cached',
                    'sort.quality': 'Resolution',
                    'sort.lang': 'Language',
                    'sort.seeds': 'Seeders',
                    'sort.size': 'Size',
                    'label.sktorrentLogin': 'Login to SKTorrent',
                    'login.uid.placeholder': 'Username',
                    'login.pass.placeholder': 'Password',
                    'button.login': 'Login',
                    'button.register': 'Register',
                    'button.loggingIn': 'Logging in...',
                    'link.manual': '▶ Enter UID and PASS manually',
                    'link.manualHide': '▼ Hide manual fields',
                    'lang.sk': 'Slovenčina',
                    'lang.en': 'English',
                }
            };

            function t(key) { return (I18N[CURR_LANG] && I18N[CURR_LANG][key]) || (I18N['en'] && I18N['en'][key]) || key; }

            function setLang(lang) {
                CURR_LANG = lang;
                localStorage.setItem('sktorrent_lang', lang);
                applyLang();
            }

            function applyLang() {
                document.querySelectorAll('[data-i18n]').forEach(function(el) {
                    var key = el.getAttribute('data-i18n');
                    el.textContent = t(key);
                });
                document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
                    var key = el.getAttribute('data-i18n-placeholder');
                    el.placeholder = t(key);
                });
                document.querySelectorAll('[data-i18n-optional]').forEach(function(el) {
                    var key = el.getAttribute('data-i18n-optional');
                    el.textContent = t(key);
                });
                document.querySelectorAll('[data-i18n-link]').forEach(function(el) {
                    var key = el.getAttribute('data-i18n-link');
                    el.textContent = t(key);
                });
                // Update SORT_LABELS & CATALOG_LABELS
                SORT_LABELS = { cached: t('sort.cached'), quality: t('sort.quality'), lang: t('sort.lang'), seeds: t('sort.seeds'), size: t('sort.size') };
                CATALOG_LABELS = {
                    skt_movies_trending: t('cat.skt_movies_trending'),
                    skt_series_popular: t('cat.skt_series_popular'),
                    skt_kids: t('cat.skt_kids'),
                    skt_kids_series: t('cat.skt_kids_series'),
                    skt_sport: t('cat.skt_sport'),
                    skt_docs: t('cat.skt_docs'),
                    skt_movies_popular: t('cat.skt_movies_popular'),
                    skt_series_new: t('cat.skt_series_new'),
                    skt_movies_new: t('cat.skt_movies_new')
                };
                // Re-render sort rows with new labels
                var sortContainer = document.getElementById('sortOrders');
                if (sortContainer) {
                    var vals = [];
                    var activeMask = [];
                    var rows = sortContainer.querySelectorAll('.sort-row');
                    for (var si = 0; si < rows.length; si++) {
                        vals.push(rows[si].dataset.value);
                        activeMask.push(rows[si].dataset.active !== 'false');
                    }
                    if (vals.length) initSortRows(vals, activeMask);
                }
                // Re-render catalog rows with new labels
                var catContainer = document.getElementById('catalogOrders');
                if (catContainer) {
                    var cvals = [];
                    var cactiveMask = [];
                    var crows = catContainer.querySelectorAll('.catalog-row');
                    for (var ci = 0; ci < crows.length; ci++) {
                        cvals.push(crows[ci].dataset.value);
                        cactiveMask.push(crows[ci].dataset.active !== 'false');
                    }
                    if (cvals.length) initCatalogRows(cvals, cactiveMask);
                }
                // Update lang switcher active state
                document.querySelectorAll('.lang-btn').forEach(function(btn) {
                    var lb = btn.getAttribute('data-lang-btn');
                    btn.classList.toggle('active', lb === CURR_LANG);
                });
            }

            function getSortValues() {
                var rows = document.querySelectorAll('#sortOrders .sort-row');
                var vals = [];
                for (var i = 0; i < rows.length; i++) {
                    if (rows[i].dataset.active !== 'false') {
                        vals.push(rows[i].dataset.value);
                    }
                }
                return vals;
            }

            function initCatalogRows(saved, activeMask) {
                var container = document.getElementById('catalogOrders');
                if (!container) return;
                container.innerHTML = '';
                var used = (saved && saved.length) ? saved.slice() : ALL_CATALOG_IDS.slice();
                for (var k = 0; k < ALL_CATALOG_IDS.length; k++) {
                    if (used.indexOf(ALL_CATALOG_IDS[k]) === -1) {
                        used.push(ALL_CATALOG_IDS[k]);
                    }
                }
                if (!activeMask || activeMask.length !== used.length) {
                    activeMask = [];
                    for (var mi = 0; mi < used.length; mi++) activeMask.push(true);
                }
                for (var i = 0; i < used.length; i++) {
                    var row = document.createElement('div');
                    row.className = 'sort-row catalog-row';
                    row.dataset.idx = i;
                    row.dataset.active = activeMask[i] ? 'true' : 'false';
                    row.dataset.value = used[i];

                    var numSpan = document.createElement('span');
                    numSpan.className = 'num';
                    numSpan.textContent = i + 1;
                    row.appendChild(numSpan);

                    var toggle = document.createElement('button');
                    toggle.className = 'sort-toggle';
                    toggle.innerHTML = activeMask[i] ? '\u25CF' : '\u25CB';
                    toggle.setAttribute('onclick', 'toggleCatalogActive(this)');
                    toggle.title = activeMask[i] ? (t('sort.toggleOff') || 'Klikni pre vypnutie') : (t('sort.toggleOn') || 'Klikni pre zapnutie');
                    row.appendChild(toggle);

                    var label = document.createElement('span');
                    label.className = 'sort-label';
                    label.textContent = CATALOG_LABELS[used[i]] || used[i];
                    label.style.flex = '1';
                    label.style.fontSize = '13px';
                    label.style.color = '#ccc';
                    row.appendChild(label);

                    var up = document.createElement('button');
                    up.className = 'sort-btn';
                    up.innerHTML = '\u25B2';
                    up.setAttribute('onclick', 'moveCatalog(this, -1)');
                    if (i === 0) up.disabled = true;
                    row.appendChild(up);

                    var down = document.createElement('button');
                    down.className = 'sort-btn';
                    down.innerHTML = '\u25BC';
                    down.setAttribute('onclick', 'moveCatalog(this, 1)');
                    if (i === used.length - 1) down.disabled = true;
                    row.appendChild(down);

                    container.appendChild(row);
                }
            }

            function toggleCatalogActive(btn) {
                var row = btn.parentNode;
                var isActive = row.dataset.active !== 'false';
                row.dataset.active = isActive ? 'false' : 'true';
                btn.innerHTML = isActive ? '\u25CB' : '\u25CF';
                btn.title = isActive ? (t('sort.toggleOn') || 'Klikni pre zapnutie') : (t('sort.toggleOff') || 'Klikni pre vypnutie');
            }

            function moveCatalog(btn, dir) {
                var row = btn.parentNode;
                var container = document.getElementById('catalogOrders');
                var rows = container.querySelectorAll('.catalog-row');
                var idx = Array.prototype.indexOf.call(rows, row);
                var newIdx = idx + dir;
                if (newIdx < 0 || newIdx >= rows.length) return;

                var vals = [];
                var activeMask = [];
                for (var i = 0; i < rows.length; i++) {
                    vals.push(rows[i].dataset.value);
                    activeMask.push(rows[i].dataset.active !== 'false');
                }
                var tmp = vals[idx];
                vals[idx] = vals[newIdx];
                vals[newIdx] = tmp;
                var tmpMask = activeMask[idx];
                activeMask[idx] = activeMask[newIdx];
                activeMask[newIdx] = tmpMask;
                initCatalogRows(vals, activeMask);
            }

            function getCatalogValues() {
                var rows = document.querySelectorAll('#catalogOrders .catalog-row');
                var activeVals = [];
                var allVals = [];
                for (var i = 0; i < rows.length; i++) {
                    allVals.push(rows[i].dataset.value);
                    if (rows[i].dataset.active !== 'false') {
                        activeVals.push(rows[i].dataset.value);
                    }
                }
                return { active: activeVals, all: allVals };
            }

            function initSortRows(saved, activeMask) {
                var container = document.getElementById('sortOrders');
                container.innerHTML = '';
                var used = saved && saved.length ? saved : SORT_OPTIONS;
                if (!activeMask || activeMask.length !== used.length) {
                    activeMask = [];
                    for (var mi = 0; mi < used.length; mi++) activeMask.push(true);
                }
                for (var i = 0; i < used.length; i++) {
                    var row = document.createElement('div');
                    row.className = 'sort-row';
                    row.dataset.idx = i;
                    row.dataset.active = activeMask[i] ? 'true' : 'false';
                    row.dataset.value = used[i];
                    var numSpan = document.createElement('span');
                    numSpan.className = 'num';
                    numSpan.textContent = i + 1;
                    row.appendChild(numSpan);

                    var toggle = document.createElement('button');
                    toggle.className = 'sort-toggle';
                    toggle.innerHTML = activeMask[i] ? '\u25CF' : '\u25CB';
                    toggle.setAttribute('onclick', 'toggleSortActive(this)');
                    toggle.title = activeMask[i] ? 'Klikni pre vypnutie' : 'Klikni pre zapnutie';
                    row.appendChild(toggle);

                    // Fixed label namiesto selectu — criterion je identita riadku
                    var label = document.createElement('span');
                    label.className = 'sort-label';
                    label.textContent = SORT_LABELS[used[i]] || used[i];
                    label.style.flex = '1';
                    label.style.fontSize = '13px';
                    label.style.color = '#ccc';
                    row.appendChild(label);

                    var up = document.createElement('button');
                    up.className = 'sort-btn';
                    up.innerHTML = '\u25B2';
                    up.setAttribute('onclick', 'moveSort(this, -1)');
                    if (i === 0) up.disabled = true;
                    row.appendChild(up);

                    var down = document.createElement('button');
                    down.className = 'sort-btn';
                    down.innerHTML = '\u25BC';
                    down.setAttribute('onclick', 'moveSort(this, 1)');
                    if (i === used.length - 1) down.disabled = true;
                    row.appendChild(down);

                    container.appendChild(row);
                }
            }

            function moveSort(btn, dir) {
                var row = btn.parentNode;
                var container = document.getElementById('sortOrders');
                var rows = container.querySelectorAll('.sort-row');
                var idx = Array.prototype.indexOf.call(rows, row);
                var newIdx = idx + dir;
                if (newIdx < 0 || newIdx >= rows.length) return;
                // Read ALL values and active states from DOM
                var vals = [];
                var activeMask = [];
                for (var si = 0; si < rows.length; si++) {
                    vals.push(rows[si].dataset.value);
                    activeMask.push(rows[si].dataset.active !== 'false');
                }
                var tmp = vals[idx];
                vals[idx] = vals[newIdx];
                vals[newIdx] = tmp;
                var tmpMask = activeMask[idx];
                activeMask[idx] = activeMask[newIdx];
                activeMask[newIdx] = tmpMask;
                initSortRows(vals, activeMask);
            }

            function toggleChip(el) {
                el.classList.toggle('active');
            }

            function toggleCheckbox(id, event) {
                if (event && event.target && event.target.type === 'checkbox') return;
                var cb = document.getElementById(id);
                cb.checked = !cb.checked;
                aktualizujCachedOnlyWarning();
            }

            function aktualizujCachedOnlyWarning() {
                var warn = document.getElementById('cachedOnlyRdWarning');
                if (!warn) return;
                var providerSel = document.getElementById('debridProvider');
                var cb = document.getElementById('cachedOnly');
                var viditelne = providerSel && providerSel.value === 'realdebrid' && cb && cb.checked;
                warn.style.display = viditelne ? '' : 'none';
            }

            function toggleSortActive(btn) {
                var row = btn.parentNode;
                var isActive = row.dataset.active !== 'false';
                row.dataset.active = isActive ? 'false' : 'true';
                btn.innerHTML = isActive ? '\u25CB' : '\u25CF';
                btn.title = isActive ? t('sort.toggleOff') : t('sort.toggleOn');
            }

            function getActiveChips(selector) {
                var chips = document.querySelectorAll(selector + '.active');
                var vals = [];
                for (var i = 0; i < chips.length; i++) {
                    var chip = chips[i];
                    var v = chip.dataset.lang || chip.dataset.show || chip.dataset.res || chip.dataset.hdr || chip.dataset.adult || chip.dataset.source || '';
                    vals.push(v);
                }
                return vals;
            }

            function generateLink() {
                var uidVal = document.getElementById('uid').value;
                var passVal = document.getElementById('pass').value;
                // Ak hidden polia su prazdne, skus manualne
                if (!uidVal || !passVal) {
                    uidVal = document.getElementById('manualUid').value;
                    passVal = document.getElementById('manualPass').value;
                }
                var debridProvider = document.getElementById('debridProvider').value;
                var jeDebridMod = debridProvider === 'torbox' || debridProvider === 'realdebrid';
                var catInfo = getCatalogValues();
                var config = {
                    uid: uidVal,
                    pass: passVal,
                    debridProvider: debridProvider,
                    torbox: document.getElementById('torbox').value,
                    realdebrid: document.getElementById('realdebrid').value,
                    tmdb: document.getElementById('tmdb').value,
                    tvdb: document.getElementById('tvdb').value,
                    catalogs: catInfo.active,
                    catOrder: catInfo.all,
                    kidsAge: document.getElementById('kidsAge') ? document.getElementById('kidsAge').value : '12',
                    lang: getActiveChips('#langChips .chip'),
                    show: getActiveChips('#showChips .chip'),
                    cachedOnly: jeDebridMod && document.getElementById('cachedOnly').checked,
                    precacheNextEpisode: jeDebridMod && document.getElementById('precacheNextEpisode').checked,
                    hdr: getActiveChips('#hdrChips .chip'),
                    adult: getActiveChips('#adultChips .chip'),
                    source: getActiveChips('#sourceChips .chip'),
                    res: getActiveChips('#resChips .chip'),
                    maxResults: document.getElementById('maxResults').value,
                    maxPerRes: document.getElementById('maxPerRes').value,
                    maxSize: document.getElementById('maxSize').value,
                    minSeeds: document.getElementById('minSeeds').value,
                    sort: getSortValues(),
                    cb: Date.now()
                };

                if ((!config.uid || !config.pass) && (!debridProvider || debridProvider === 'p2p')) {
                    alert(t('alert.fillUidPass'));
                    return;
                }
                
                // Ak je debrid, uid/pass nie su potrebne — pouzijeme placeholder aby
                // server neodmietol config (uid/pass sa ignoruju pre debrid)
                if (!config.uid) config.uid = '';
                if (!config.pass) config.pass = '';

                try {
                    var jsonString = JSON.stringify(config);
                    var encodedConfig = btoa(unescape(encodeURIComponent(jsonString)))
                        .split('+').join('-')
                        .split('/').join('_')
                        .split('=').join('');

                    var baseUrl = window.location.origin;
                    if (!baseUrl || baseUrl === "null") {
                        baseUrl = window.location.protocol + "//" + window.location.host;
                    }

                    var finalHttpUrl = baseUrl + '/' + encodedConfig + '/manifest.json';

                    document.getElementById('result-box').style.display = 'block';
                    document.getElementById('generated-url').value = finalHttpUrl;
                    setTimeout(function() {
                        document.getElementById('result-box').scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 100);
                } catch (error) {
                    alert(t('alert.codeError'));
                    console.error(error);
                }
            }

            function copyUrl() {
                var urlText = document.getElementById('generated-url');
                urlText.select();
                document.execCommand('copy');
                var copyBtn = document.querySelector('.btn-copy span[data-i18n="button.copy"]');
                if (copyBtn) {
                    copyBtn.textContent = t('button.copied');
                    setTimeout(function() { copyBtn.textContent = t('button.copyIdle'); }, 2000);
                }
            }

            function openStremio() {
                var httpUrl = document.getElementById('generated-url').value;
                var stremioUrl = httpUrl.replace("https://", "stremio://").replace("http://", "stremio://");
                window.location.assign(stremioUrl);
            }

            function toggleDebridFields() {
                var provider = document.getElementById('debridProvider').value;
                var torboxField = document.getElementById('torboxField');
                var realdebridField = document.getElementById('realdebridField');
                var sktorrentSection = document.getElementById('sktorrentSection');
                var debridMod = provider === 'torbox' || provider === 'realdebrid';

                // Debrid API fields
                if (torboxField) torboxField.style.display = (provider === 'torbox') ? '' : 'none';
                if (realdebridField) realdebridField.style.display = (provider === 'realdebrid') ? '' : 'none';

                // SKTorrent login: vždy viditeľný (zrýchli vyhľadávanie v každom móde)
                if (sktorrentSection) sktorrentSection.style.display = 'block';

                // Cached Only aj Pre-cache dávajú zmysel len s debrid službou (P2P nemá cache)
                var cachedRow = document.getElementById('cachedOnlyRow');
                var precacheRow = document.getElementById('precacheRow');
                if (cachedRow) cachedRow.style.display = debridMod ? '' : 'none';
                if (precacheRow) precacheRow.style.display = debridMod ? '' : 'none';

                // Sortovanie podľa Cached tiež len v debrid móde
                upravitSortPreProvider();
                aktualizujCachedOnlyWarning();
            }

            function upravitSortPreProvider() {
                var providerSel = document.getElementById('debridProvider');
                var container = document.getElementById('sortOrders');
                if (!providerSel || !container) return;
                var debridMod = providerSel.value === 'torbox' || providerSel.value === 'realdebrid';
                var vals = [], act = [];
                var rows = container.querySelectorAll('.sort-row');
                for (var i = 0; i < rows.length; i++) {
                    vals.push(rows[i].dataset.value);
                    act.push(rows[i].dataset.active !== 'false');
                }
                var idx = vals.indexOf('cached');
                if (debridMod && idx === -1) {
                    // Debrid: Cached vrátime na prvú pozíciu (predvolené poradie)
                    vals.unshift('cached');
                    act.unshift(true);
                    initSortRows(vals, act);
                } else if (!debridMod && idx !== -1) {
                    // P2P / žiadna služba: Cached nemá zmysel, odstránime
                    vals.splice(idx, 1);
                    act.splice(idx, 1);
                    initSortRows(vals, act);
                }
            }

            function toggleManualFields(e) {
                e.preventDefault();
                var el = document.getElementById('manualFields');
                var link = e.target;
                if (el.style.display === 'none') {
                    el.style.display = 'block';
                    link.innerHTML = '▼ ' + t('link.manualHide') || '▼ Skryť manuálne polia';
                } else {
                    el.style.display = 'none';
                    link.innerHTML = '▶ ' + t('link.manual') || '▶ Manuálne zadať UID a PASS';
                }
            }

            function loginToSKTorrent() {
                var username = document.getElementById('loginUser').value.trim();
                var password = document.getElementById('loginPass').value;
                var statusEl = document.getElementById('loginStatus');
                var btn = document.getElementById('loginBtn');

                if (!username || !password) {
                    statusEl.innerHTML = '<span style="color:#ff6b6b;">❌ Vyplň meno aj heslo</span>';
                    return;
                }

                btn.disabled = true;
                btn.style.opacity = '0.6';
                btn.textContent = t('button.loggingIn') || 'Prihlasujem...';
                statusEl.innerHTML = '<span style="color:#888;">⏳ Prihlasujem na SKTorrent...</span>';

                fetch('/api/sktorrent-login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: username, password: password })
                })
                .then(function(res) { return res.json(); })
                .then(function(data) {
                    if (data.error) {
                        statusEl.innerHTML = '<span style="color:#ff6b6b;">❌ ' + data.error + '</span>';
                        btn.disabled = false;
                        btn.style.opacity = '1';
                        btn.textContent = t('button.login') || 'Prihlásiť sa';
                        return;
                    }
                    // Uloz uid/pass do hidden fields
                    document.getElementById('uid').value = data.uid;
                    document.getElementById('pass').value = data.pass;
                    // Vypis uid/pass aj do manual fields
                    document.getElementById('manualUid').value = data.uid;
                    document.getElementById('manualPass').value = data.pass;
                    // Schovaj login polia, ukaz success s uid/pass
                    document.getElementById('loginFields').style.display = 'none';
                    statusEl.innerHTML = '<span style="color:#4caf50;">✅ Prihlásený ako <strong>' + data.username + '</strong><br><span style="font-size:11px;color:#888;">UID: ' + data.uid + ' | PASS: ' + data.pass.substring(0, 8) + '...</span></span>';
                    btn.disabled = false;
                    btn.style.opacity = '1';
                })
                .catch(function(err) {
                    statusEl.innerHTML = '<span style="color:#ff6b6b;">❌ Chyba spojenia so serverom</span>';
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    btn.textContent = t('button.login') || 'Prihlásiť sa';
                });
            }

            // Initialise catalog order
            var savedCatOrder = ${(() => {
                const co = currentConfig.catOrder;
                if (co && Array.isArray(co)) return JSON.stringify(co);
                const cats = currentConfig.catalogs;
                if (cats && Array.isArray(cats)) return JSON.stringify(cats);
                return 'null';
            })()};
            var savedCatActive = ${(() => {
                const cats = currentConfig.catalogs;
                const catOrder = currentConfig.catOrder;
                if (cats && Array.isArray(cats) && catOrder && Array.isArray(catOrder)) {
                    const mask = catOrder.map(id => cats.includes(id));
                    return JSON.stringify(mask);
                } else if (cats && Array.isArray(cats)) {
                    const mask = cats.map(() => true);
                    return JSON.stringify(mask);
                }
                return 'null';
            })()};
            initCatalogRows(savedCatOrder, savedCatActive);

            // Initialise sort order
            var savedSort = ${(() => {
                const sort = currentConfig.sort;
                if (sort && Array.isArray(sort)) return JSON.stringify(sort);
                if (sort && typeof sort === 'string') {
                    try { return JSON.stringify(JSON.parse(sort)); } catch(e) {}
                }
                return 'null';
            })()};
            initSortRows(savedSort);
            // Initialise kids age
            var savedKidsAge = ${JSON.stringify(currentConfig.kidsAge || '12')};
            var kidsAgeEl = document.getElementById('kidsAge');
            if (kidsAgeEl && savedKidsAge) {
                kidsAgeEl.value = savedKidsAge;
            }

            // Apply debrid field visibility on load
            toggleDebridFields();
            // Apply saved language on load
            applyLang();
        </script>
    </body>
    </html>
    `;

    res.send(html);
});

// ===================================================================
// KATALÓGY (POPULÁRNE / TRENDING / NAJNOVŠIE Z SKTORRENT)
// ===================================================================

const SKT_CATALOGS = [
    {
        type: "movie",
        id: "skt_movies_trending",
        name: "SKTorrent - Dnes populárne",
        category: 1,
        order: "seeds",
        active: 1
    },
    {
        type: "series",
        id: "skt_series_popular",
        name: "SKTorrent - Najsťahovanejšie seriály",
        category: 16,
        order: "finished",
        active: 0
    },
    {
        type: "movie",
        id: "skt_kids",
        name: "SKTorrent - Pre deti",
        category: 5,
        order: "seeds",
        active: 0
    },
    {
        type: "series",
        id: "skt_kids_series",
        name: "SKTorrent - Detské seriály",
        category: 16,
        order: "data",
        active: 0,
        zaner: "Animovany"
    },
    {
        type: "other",
        id: "skt_sport",
        name: "SKTorrent - Šport",
        category: 44,
        order: "data",
        active: 0
    },
    {
        type: "movie",
        id: "skt_docs",
        name: "SKTorrent - Dokumenty",
        category: 17,
        order: "data",
        active: 0
    },
    {
        type: "movie",
        id: "skt_movies_popular",
        name: "SKTorrent - Najsťahovanejšie filmy",
        category: 1,
        order: "finished",
        active: 0
    },
    {
        type: "series",
        id: "skt_series_new",
        name: "SKTorrent - Najnovšie seriály",
        category: 16,
        order: "data",
        active: 0
    },
    {
        type: "movie",
        id: "skt_movies_new",
        name: "SKTorrent - Najnovšie filmy",
        category: 1,
        order: "data",
        active: 0
    }
];

function cleanDirectTitle(rawTitle) {
    let t = String(rawTitle || "").trim();
    t = t.replace(/^Stiahni si\s+(?:Filmy Kreslené|Kreslené|Sport|Šport|Dokument|Filmy|Seriál|TV Pořad)[^:]*?(?::|\s{2,}|(?=[A-Z0-9]))/i, "").trim();
    t = t.replace(/^Stiahni si\s+(?:Filmy Kreslené|Kreslené|Sport|Šport|Dokument|Filmy|Seriál|TV Pořad)\s*/i, "").trim();
    t = t.replace(/^Kreslené\s+/i, "").trim();
    t = t.replace(/^Stiahni si\s*/i, "").trim();
    t = t.replace(/=\s*CSFD\s*\d+%/gi, "").trim();
    return t;
}

const sktMetaCache = new Map();

function saveSktMeta(metaItem) {
    if (!metaItem || !metaItem.id) return;
    sktMetaCache.set(metaItem.id, metaItem);
    if (sktMetaCache.size > 3000) {
        const first = sktMetaCache.keys().next().value;
        sktMetaCache.delete(first);
    }
}

function cleanCatalogTitle(rawTitle, type) {
    let t = String(rawTitle || "");
    t = t.replace(/^Stiahni si\s+(?:Filmy Kreslené|Kreslené|Filmy|Seriál|Dokument|TV Pořad|Sport|Šport)[^:]*?(?:CZ\/SK|SK\/CZ)?[^:]*?dabing/i, "");
    t = t.replace(/^Stiahni si\s+(?:Filmy Kreslené|Kreslené|Filmy|Seriál|Dokument|TV Pořad|Sport|Šport)/i, "");
    t = t.replace(/^Kreslené\s+/i, "");
    t = t.replace(/\b(?:CZ\/SK|SK\/CZ|CZ\/EN|SK\/EN)\b/gi, "");
    t = t.replace(/=\s*CSFD\s*\d+%/gi, "").trim();

    let year = null;
    const yearMatch = t.match(/\b(19\d\d|20\d\d)\b/);
    if (yearMatch) year = yearMatch[1];

    if (type === "series") {
        t = t.replace(/\bS\d+E\d+\b/gi, "")
             .replace(/\bS\d+\b/gi, "")
             .replace(/\d+\.\s*(?:serie|séria|rada)\b/gi, "")
             .replace(/\d+x\d+\b/gi, "")
             .replace(/\d+\.\s*(?:díl|epizoda|epizóda)\b/gi, "");
    }

    t = t.replace(/\[.*?\]/g, " ").replace(/\(.*?\)/g, " ").trim();
    t = t.replace(/\s+/g, " ");

    const parts = t.split("/").map(p => p.trim()).filter(p => p.length >= 2);
    return { parts, year, rawClean: parts[0] || t };
}

function isAgeAppropriate(item, matchedMeta, maxAge) {
    if (!maxAge || maxAge === 'all') return true;
    const age = parseInt(maxAge, 10);
    if (isNaN(age)) return true;

    const rawTitle = (item.rawTitle || '').toLowerCase();
    const cleanTitle = (item.titleObj?.rawClean || matchedMeta?.name || '').toLowerCase();
    const zanre = (item.zanre || []).map(z => z.toLowerCase());
    const cinemetaGenres = (matchedMeta?.genres || []).map(g => g.toLowerCase());
    const allGenres = [...zanre, ...cinemetaGenres];

    // 1. Explicitné označenie veku v názve torrentu
    if (rawTitle.includes('18+') || rawTitle.includes('[18+]') || rawTitle.includes('(18+)') || rawTitle.includes('18 +')) {
        return false;
    }
    if (age < 18 && (allGenres.includes('eroticky') || allGenres.includes('erotic') || allGenres.includes('adult') || rawTitle.includes('xxx'))) {
        return false;
    }
    if (age < 15 && (rawTitle.includes('15+') || rawTitle.includes('[15+]') || rawTitle.includes('(15+)'))) {
        return false;
    }
    if (age < 12 && (rawTitle.includes('12+') || rawTitle.includes('[12+]') || rawTitle.includes('(12+)'))) {
        return false;
    }

    // 2. Obsah pre dospelých a nevhodné žánre pre deti <= 12 rokov
    if (age <= 12) {
        const matureGenres = [
            'horor', 'horror',
            'thriller',
            'krimi', 'crime',
            'valecny', 'war',
            'eroticky', 'erotic', 'adult',
            'psychologicky', 'psychological'
        ];
        if (allGenres.some(g => matureGenres.includes(g))) {
            return false;
        }

        // Animované seriály / filmy určené výhradne pre dospelých (Adult animation)
        const adultAnimations = [
            'south park', 'rick and morty', 'rick & morty', 'family guy', 'griffinovi',
            'griffinoci', 'futurama', 'bojack', 'sausage party', 'buchty a klobásy',
            'archer', 'big mouth', 'harley quinn', 'invincible', 'hazbin hotel',
            'helluva boss', 'castlevania', 'deadpool', 'chainsaw man', 'attack on titan'
        ];
        if (adultAnimations.some(a => cleanTitle.includes(a) || rawTitle.includes(a))) {
            return false;
        }

        // Kľúčové slová násilia a brutality
        const matureWords = [
            'vražda', 'vrah', 'masaker', 'zabijak', 'blood', 'krve',
            'smrť', 'death', 'mŕtv', 'dead', 'porn', 'sex', 'erotik'
        ];
        if (matureWords.some(w => rawTitle.includes(w) || cleanTitle.includes(w))) {
            return false;
        }
    }

    // 3. Pre predškolákov a malé deti (vek <= 6 rokov)
    if (age <= 6) {
        const nonToddlerGenres = ['akcni', 'action', 'drama', 'mysteriozni', 'mystery', 'katastroficky'];
        if (allGenres.some(g => nonToddlerGenres.includes(g))) {
            return false;
        }
        const scaryWords = [
            'démon', 'demon', 'diabol', 'devil', 'zombie', 'temn', 'dark'
        ];
        if (scaryWords.some(w => rawTitle.includes(w) || cleanTitle.includes(w))) {
            return false;
        }
    }

    return true;
}

async function matchCinemetaForCatalog(titleObj, type) {
    if (!titleObj || !titleObj.parts || titleObj.parts.length === 0) return null;

    for (const part of titleObj.parts.slice().reverse()) {
        const cleanPart = part.trim();
        if (cleanPart.length < 3) continue;

        const cacheKey = `cinemeta_cat_v2_${type}:${cleanPart}`;
        const match = await withCache(cacheKey, 86400000, async () => {
            try {
                const url = `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(cleanPart)}.json`;
                const res = await axios.get(url, {
                    timeout: 3500,
                    httpAgent: sharedHttpAgent,
                    httpsAgent: sharedHttpsAgent,
                    headers: { "User-Agent": "Stremio" }
                });
                const metas = res.data?.metas;
                if (Array.isArray(metas) && metas.length > 0) {
                    const first = metas[0];
                    const firstNorm = odstranDiakritiku(first.name.toLowerCase()).replace(/[^a-z0-9]/g, "");
                    const partNorm = odstranDiakritiku(cleanPart.toLowerCase()).replace(/[^a-z0-9]/g, "");

                    if (firstNorm.length < 2 || partNorm.length < 2) return null;
                    if (!firstNorm.includes(partNorm) && !partNorm.includes(firstNorm)) {
                        const firstWords = odstranDiakritiku(first.name.toLowerCase()).split(/\s+/).filter(w => w.length > 2);
                        const partWords = odstranDiakritiku(cleanPart.toLowerCase()).split(/\s+/).filter(w => w.length > 2);
                        const hasOverlap = partWords.some(pw => firstWords.includes(pw));
                        if (!hasOverlap) return null;
                    }

                    return {
                        id: first.id,
                        type: first.type || type,
                        name: first.name,
                        poster: first.poster,
                        releaseInfo: first.releaseInfo || first.year || titleObj.year,
                        description: first.description || "",
                        imdbRating: first.imdbRating
                    };
                }
            } catch (e) {
                // ignore timeout/error
            }
            return null;
        });
        if (match) return match;
    }
    return null;
}

async function fetchSkTorrentCatalog(catalogDef, skip = 0, userAxios = axios, userConfig = {}) {
    const page = Math.floor(skip / 24);
    const kidsAge = userConfig?.kidsAge || '12';
    const isKids = catalogDef.id.startsWith('skt_kids');
    const cacheKey = `catalog_v5_${catalogDef.id}_${isKids ? 'age_' + kidsAge + '_' : ''}page_${page}`;

    return withCache(cacheKey, 1800000, async () => {
        logApi(`Fetching catalog ${catalogDef.name} (Page ${page}, KidsAge: ${kidsAge})...`);
        try {
            const queryParams = {
                category: catalogDef.category,
                order: catalogDef.order,
                by: 'DESC',
                page: page,
                active: catalogDef.active || 0
            };
            if (catalogDef.zaner) {
                queryParams.zaner = catalogDef.zaner;
            }

            const res = await userAxios.get(SEARCH_URL, {
                params: queryParams,
                timeout: 8000
            });

            const $ = cheerio.load(res.data);
            const rawItems = [];
            const seenIds = new Set();
            const seenSeriesTitles = new Set();

            $('a[href^="details.php"] img').each((i, img) => {
                const a = $(img).closest("a");
                const href = a.attr("href") || "";
                const torrentId = href.split("id=").pop();
                if (!torrentId || seenIds.has(torrentId)) return;
                seenIds.add(torrentId);

                const rawTitle = a.attr("title") || a.text().trim() || "";
                const poster = $(img).attr("data-src") || $(img).attr("src") || "";
                const td = a.closest("td");
                const text = td.text().replace(/\s+/g, " ").trim();
                const velkostMatch = text.match(/Velkost\s([^|]+)/i);
                const seedMatch = text.match(/Odosielaju\s*:\s*(\d+)/i);
                const size = velkostMatch ? velkostMatch[1].trim() : "";
                const seeds = seedMatch ? parseInt(seedMatch[1]) : 0;

                const zanre = [];
                td.find('a[href*="zaner="]').each((_, z) => {
                    const zText = $(z).text().trim();
                    if (zText) zanre.push(zText);
                });

                const titleObj = cleanCatalogTitle(rawTitle, catalogDef.type);

                if (catalogDef.type === "series") {
                    const canonical = (titleObj.parts[0] || "").toLowerCase();
                    if (canonical && seenSeriesTitles.has(canonical)) return;
                    if (canonical) seenSeriesTitles.add(canonical);
                }

                rawItems.push({
                    torrentId,
                    rawTitle,
                    poster,
                    size,
                    seeds,
                    zanre,
                    titleObj
                });
            });

            const isDirectCatalog = catalogDef.id.startsWith('skt_sport') || catalogDef.id === 'skt_docs';

            if (isDirectCatalog) {
                logInfo(`Catalog ${catalogDef.id}: direct mode, bypassing Cinemeta for ${rawItems.length} items`);
                const metas = rawItems.map(item => {
                    const cleanTitle = cleanDirectTitle(item.rawTitle);
                    const posterUrl = item.poster && item.poster.startsWith('http')
                        ? item.poster 
                        : `https://cdn.sktorrent.eu/obrazky/${item.torrentId}.jpg`;
                    const sktMeta = {
                        id: `skt:${item.torrentId}`,
                        type: catalogDef.type,
                        name: cleanTitle,
                        poster: posterUrl,
                        background: posterUrl,
                        releaseInfo: item.titleObj.year || undefined,
                        description: `SKTorrent | ${item.size || '?'} | Seeders: ${item.seeds}`,
                        size: item.size,
                        seeds: item.seeds,
                        category: catalogDef.id.startsWith('skt_sport') ? 'Sport' : 'Dokument'
                    };
                    saveSktMeta(sktMeta);
                    return sktMeta;
                });
                logSuccess(`Catalog ${catalogDef.id}: ready with ${metas.length} items`);
                return metas;
            }

            logInfo(`Catalog ${catalogDef.id}: found ${rawItems.length} torrents, resolving Cinemeta...`);

            const metas = [];
            for (let i = 0; i < rawItems.length; i += 6) {
                const chunk = rawItems.slice(i, i + 6);
                const chunkMetas = await Promise.all(chunk.map(async (item) => {
                    const matched = await matchCinemetaForCatalog(item.titleObj, catalogDef.type);

                    // Overenie vekovej vhodnosti pre Kids katalógy alebo keď je zapnutý filter
                    if (isKids || (userConfig?.kidsAge && userConfig.kidsAge !== 'all')) {
                        if (!isAgeAppropriate(item, matched, kidsAge)) {
                            return null;
                        }
                    }

                    if (matched) {
                        return matched;
                    }
                    const fallbackTitle = cleanDirectTitle(item.titleObj.rawClean || item.rawTitle);
                    const posterUrl = item.poster && item.poster.startsWith('http')
                        ? item.poster
                        : `https://cdn.sktorrent.eu/obrazky/${item.torrentId}.jpg`;
                    const fallbackMeta = {
                        id: `skt:${item.torrentId}`,
                        type: catalogDef.type,
                        name: fallbackTitle,
                        poster: posterUrl,
                        background: posterUrl,
                        releaseInfo: item.titleObj.year || undefined,
                        description: `SKTorrent | ${item.size} | Seeders: ${item.seeds}`,
                        size: item.size,
                        seeds: item.seeds,
                        category: isKids ? "Rozpravka" : (catalogDef.type === "series" ? "Serial" : "Film")
                    };
                    saveSktMeta(fallbackMeta);
                    return fallbackMeta;
                }));
                metas.push(...chunkMetas.filter(Boolean));
            }

            logSuccess(`Catalog ${catalogDef.id}: ready with ${metas.length} items`);
            return metas;
        } catch (err) {
            logError(`Failed to fetch catalog ${catalogDef.id}`, err);
            return [];
        }
    });
}

// --- Manifest Route ---
const handleManifest = (req, res) => {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Surrogate-Control': 'no-store'
    });

    const userConfig = req.params?.config ? decodeConfig(req.params.config) : null;
    let selectedCatalogs = SKT_CATALOGS;

    if (userConfig && Array.isArray(userConfig.catalogs)) {
        const ordered = [];
        for (const catId of userConfig.catalogs) {
            const found = SKT_CATALOGS.find(c => c.id === catId);
            if (found) ordered.push(found);
        }
        selectedCatalogs = ordered;
    }

    const typesSet = new Set(selectedCatalogs.map(c => c.type));
    typesSet.add("movie");
    typesSet.add("series");
    if (selectedCatalogs.some(c => c.type === "other")) {
        typesSet.add("other");
    }

    res.json({
        id: "org.stremio.sktorrent.addon", 
        version: "2.6.0",
        name: "TorrentSK",
        description: "SKTorrent s TorBox / Real-Debrid prehrávaním, ČSFD a katalógmi",
        logo: `${PUBLIC_URL}/logo.png`,
        icon: `${PUBLIC_URL}/logo.png`,
        types: Array.from(typesSet),
        catalogs: selectedCatalogs.map(c => ({
            type: c.type,
            id: c.id,
            name: c.name,
            extra: [{ name: "skip", isRequired: false }]
        })),
        resources: ["stream", "catalog", "meta"],
        idPrefixes: ["tt", "tvdb-", "tvdb:", "tmdb:", "skt:"],
        behaviorHints: {
            configurable: true,
            configurationRequired: false
        }
    });
};

app.get('/manifest.json', handleManifest);
app.get('/:config/manifest.json', handleManifest);

app.get([
    '/catalog/:type/:id.json',
    '/catalog/:type/:id/:extra.json',
    '/:config/catalog/:type/:id.json',
    '/:config/catalog/:type/:id/:extra.json'
], asyncRoute(async (req, res) => {
    const { type, id, config, extra } = req.params;
    const catalogDef = SKT_CATALOGS.find(c => c.id === id && (c.type === type || id.startsWith('skt_sport') || id === 'skt_docs' || id.startsWith('skt_kids')));
    if (!catalogDef) {
        return res.json({ metas: [] });
    }

    let skip = 0;
    if (extra) {
        const skipMatch = extra.match(/skip=(\d+)/);
        if (skipMatch) skip = parseInt(skipMatch[1], 10);
    }
    if (req.query.skip) {
        skip = parseInt(req.query.skip, 10) || skip;
    }

    const userConfig = config ? decodeConfig(config) : {};
    const userAxios = getFastAxios(userConfig || {});

    const metas = await fetchSkTorrentCatalog(catalogDef, skip, userAxios, userConfig);
    res.setHeader('Cache-Control', 'max-age=1800, stale-while-revalidate=1800');
    return res.json({ metas: metas || [] });
}));

app.get([
    '/meta/:type/:id.json',
    '/:config/meta/:type/:id.json'
], asyncRoute(async (req, res) => {
    const { type, id } = req.params;
    if (id && id.startsWith('skt:')) {
        const torrentId = id.replace(/^skt:/, '');
        const cached = sktMetaCache.get(id);
        const poster = cached?.poster || `https://cdn.sktorrent.eu/obrazky/${torrentId}.jpg`;
        const meta = {
            id,
            type: type || cached?.type || "movie",
            name: cached?.name || `SKTorrent (${torrentId.substring(0, 8)})`,
            poster: poster,
            background: cached?.background || poster,
            description: cached?.description || "Prehrávanie cez SKTorrent doplnok",
            releaseInfo: cached?.releaseInfo || undefined
        };
        res.setHeader('Cache-Control', 'max-age=3600, stale-while-revalidate=1800');
        return res.json({ meta });
    }
    return res.status(404).json({ err: "Not found" });
}));

// --- Stream Route ---
app.get('/:config/stream/:type/:id.json', asyncRoute(async (req, res) => {
    // Zabránime cacheovaniu na úrovni nginx/CDN — každý refresh musí ísť do addonu
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0, s-maxage=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('CDN-Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('X-Accel-Expires', '0');
    
    const { type: aplikaciaTyp, id, config } = req.params;
    const startCas = Date.now();
    
    logInfo(`Stream request started | Type: ${aplikaciaTyp} | ID: ${id}`);
    
    const userConfig = decodeConfig(config);
    const activeUid = userConfig?.user_id || userConfig?.uid;
    const activePass = userConfig?.password || userConfig?.pass;
    const activeTorbox = userConfig?.tb_key || userConfig?.torbox;
    const activeTmdb = userConfig?.tm_key || userConfig?.tmdb;
    const activePreferDub = userConfig?.preferDub === true;

    if (!activeUid || !activePass) {
        // Debrid-only režim (TorBox/RD) nepotrebuje SKTorrent login
        const maDebrid = !!(activeTorbox || userConfig?.realdebrid);
        if (!maDebrid) {
            logWarn(`Stream request denied - Invalid or missing config (no login, no debrid).`);
            return res.json({ streams: [], error: "Neplatná konfigurácia." });
        }
        logInfo(`Debrid-only config: ${activeTorbox ? 'TorBox' : 'Real-Debrid'} — SKTorrent login not required`);
    }
    
    // Backward compatibility: map old config fields to new ones
    // Old showUncached → new cachedOnly (inverted)
    if (userConfig.showUncached !== undefined && userConfig.cachedOnly === undefined) {
        userConfig.cachedOnly = !userConfig.showUncached;
    }
    // Old sizeOrder → new sort array
    if (userConfig.sizeOrder && !userConfig.sort) {
        if (userConfig.sizeOrder === 'asc') {
            userConfig.sort = ['quality', 'size', 'seeds'];
        } else {
            userConfig.sort = ['cached', 'quality', 'seeds', 'size'];
        }
    }
    // Old sortBy → new sort array
    if (userConfig.sortBy && !userConfig.sort) {
        if (userConfig.sortBy === 'quality') userConfig.sort = ['cached', 'quality', 'lang', 'seeds', 'size'];
        else if (userConfig.sortBy === 'seeds') userConfig.sort = ['cached', 'seeds', 'quality', 'size'];
        else if (userConfig.sortBy === 'size') userConfig.sort = ['cached', 'size', 'quality', 'seeds'];
        else if (userConfig.sortBy === 'sizeAsc') userConfig.sort = ['cached', 'size', 'quality', 'seeds'];
    }
    // Old maxQuality → new res array
    if (userConfig.maxQuality && !userConfig.res) {
        const mq = parseInt(userConfig.maxQuality);
        const allRes = ['2160p', '1080p', '720p', 'sd'];
        if (mq >= 4) userConfig.res = allRes; // 4K = all
        else if (mq === 3) userConfig.res = ['1080p', '720p', 'sd']; // 1080p max
        else if (mq === 2) userConfig.res = ['720p', 'sd'];
        else userConfig.res = ['sd'];
    }
    // Old language single string → new lang array
    if (userConfig.language && !userConfig.lang) {
        if (userConfig.language === 'all' || userConfig.language === '') userConfig.lang = ['sk', 'cz', 'en', 'multi'];
        else if (userConfig.language === 'skcz') userConfig.lang = ['sk', 'cz'];
        else userConfig.lang = [userConfig.language];
    }

    const normalizedConfig = { uid: activeUid, pass: activePass, torbox: activeTorbox, tmdb: activeTmdb, tvdb: userConfig.tvdb, preferDub: activePreferDub };
    const userAxios = getFastAxios(normalizedConfig);
    // userKey = hash uid — fingerprint účtu pre cache namespacing (bez raw UID v logoch)
    const userKey = crypto.createHash("sha1").update(String(activeUid || "")).digest("hex").slice(0, 8);
    console.log(`\n====== 🎬 Hľadám (user: ${userKey}) | id='${id}' ======`);

    // Parsovanie ID — podporuje všetky formáty:
    //   tt1234567           (movie)
    //   tt1234567:1:1       (series, IMDb)
    //   tmdb:295879:1:1     (series, AioMetadata)
    //   tvdb:466037:1:1     (series, TVDB addon)
    //   tvdb-466037:1:1     (series, TVDB addon variant)
    //   tvdb:466037:official:1:1  (series, TVDB addon — oficiálny formát s 'official')
    //   skt:hash:1:1        (direct SKTorrent item)
    const sktMatch = id.match(/^skt:([a-zA-Z0-9_-]+)(?::(\d+):(\d+))?$/i);
    const imdbMatch = id.match(/^(tt\d+)(?::(\d+):(\d+))?$/);
    const tmdbMatch = id.match(/^tmdb:(\d+)(?::(\d+):(\d+))?$/);
    const tvdbMatch = id.match(/^tvdb[-: ]?(\d+)(?::official)?(?::(\d+):(\d+))?$/);

    let rawId, seria, epizoda, vlastnyTyp;
    let sktDirectId = null;
    if (sktMatch) {
        sktDirectId = sktMatch[1];
        rawId = `skt:${sktDirectId}`;
        seria = sktMatch[2] ? parseInt(sktMatch[2]) : undefined;
        epizoda = sktMatch[3] ? parseInt(sktMatch[3]) : undefined;
        vlastnyTyp = sktMatch[2] ? "series" : "movie";
    } else if (imdbMatch) {
        rawId = imdbMatch[1];
        seria = imdbMatch[2] ? parseInt(imdbMatch[2]) : undefined;
        epizoda = imdbMatch[3] ? parseInt(imdbMatch[3]) : undefined;
        vlastnyTyp = imdbMatch[2] ? "series" : "movie";
    } else if (tmdbMatch) {
        rawId = `tmdb:${tmdbMatch[1]}`;
        seria = tmdbMatch[2] ? parseInt(tmdbMatch[2]) : undefined;
        epizoda = tmdbMatch[3] ? parseInt(tmdbMatch[3]) : undefined;
        vlastnyTyp = tmdbMatch[2] ? "series" : "movie";
    } else if (tvdbMatch) {
        rawId = `tvdb:${tvdbMatch[1]}`;
        seria = tvdbMatch[2] ? parseInt(tvdbMatch[2]) : undefined;
        epizoda = tvdbMatch[3] ? parseInt(tvdbMatch[3]) : undefined;
        vlastnyTyp = tvdbMatch[2] ? "series" : "movie";
    } else {
        // Neznámy formát — spadneme na pôvodnú logiku (aspoň niečo)
        const jeToSerialPodlaId = id.includes(":");
        const [r, s, e] = id.split(":");
        rawId = r;
        seria = (jeToSerialPodlaId && s) ? parseInt(s) : undefined;
        epizoda = (jeToSerialPodlaId && e) ? parseInt(e) : undefined;
        vlastnyTyp = jeToSerialPodlaId ? "series" : "movie";
    }

    // TVDB ID formát (z TVDB addonu / AioMetadata): tvdb-466037, tvdb:466037
    // alebo tvdb-466037:1:1. Cinemeta/TMDB takéto seriály často nepoznajú
    // (napr. Party Shore Slovensko), preto názvy načítame priamo z TVDB API.
    const tvdbIdMatch = rawId.match(/^tvdb[-: ]?(\d+)$/);
    const jeTvdbId = !!tvdbIdMatch;

    // TMDB ID formát (z AioMetadata): tmdb:295879 alebo tmdb:295879:1:1
    const tmdbIdMatch = rawId.match(/^tmdb:(\d+)$/);
    const jeTmdbId = !!tmdbIdMatch;

    // 1. ZÍSKAME NÁZVY A ROK a META
    let metaData = null;
    if (sktDirectId) {
        const cached = sktMetaCache.get(rawId);
        const sktTitle = cached?.name || `SKTorrent #${sktDirectId.substring(0, 8)}`;
        metaData = {
            nazvy: [sktTitle],
            rok: cached?.releaseInfo || null,
            meta: { titleOriginal: sktTitle, titleCz: sktTitle, yearStart: cached?.releaseInfo || null, yearEnd: null }
        };
    } else if (jeTvdbId) {
        const tvdbId = tvdbIdMatch[1];
        const nazvy = new Set();
        await pridajTvdbNazvy(nazvy, tvdbId, userConfig.tvdb);
        if (nazvy.size > 0) {
            metaData = {
                nazvy: [...nazvy],
                rok: null,
                meta: { titleOriginal: [...nazvy][0], titleCz: [...nazvy][0], yearStart: null, yearEnd: null }
            };
            logApi(`TVDB ID ${tvdbId} → názvy: ${[...nazvy].join(", ")}`);
        }
    }
    if (jeTmdbId) {
        const tmdbId = tmdbIdMatch[1];
        const nazvy = new Set();
        await pridajTmdbNazvy(nazvy, tmdbId, userConfig.tmdb);
        if (nazvy.size > 0) {
            metaData = {
                nazvy: [...nazvy],
                rok: null,
                meta: { titleOriginal: [...nazvy][0], titleCz: [...nazvy][0], yearStart: null, yearEnd: null }
            };
            logApi(`TMDB ID ${tmdbId} → názvy: ${[...nazvy].join(", ")}`);
        }
    }
    if (!metaData) {
        metaData = await ziskatVsetkyNazvyARok(rawId, vlastnyTyp, userConfig.tmdb, userConfig.tvdb);
    }
    const suroveNazvy = metaData?.nazvy || [];
    const vydanyRok = metaData?.rok;
    const metaInfo = metaData?.meta;

    if (!suroveNazvy.length) {
        logWarn(`No metadata names found. Returning empty list.`);
        return res.json({ streams: [] });
    }

    const zakladneNazvy = [];
    suroveNazvy.forEach(t => {
        let cistyT = t.replace(/\(.*?\)/g, "").replace(/TV (Mini )?Series/gi, "").trim();
        zakladneNazvy.push(cistyT);
        if (cistyT.includes(":")) zakladneNazvy.push(cistyT.split(":")[0].trim());
    });
    const unikatneNazvy = [...new Set(zakladneNazvy)];

    // 2. ČSFD LINK — hľadáme podľa presného ČSFD URL (nájde aj tituly s odlišným SK/CZ názvom)
    // Pre TVDB ID nemáme IMDb ID — ČSFD vynecháme, hľadáme priamo podľa názvu.
        const hlavnyNazov = metaData?.meta?.titleOriginal || unikatneNazvy[0];
        const csfdLink = (jeTvdbId || sktDirectId) ? null : await ziskatCsfdUrl(rawId, hlavnyNazov, vydanyRok, vlastnyTyp);
    
    let torrenty = [];
    const videnieTorrentIds = new Set();
    let uspesneNajdeneCezCsfd = false;

    const spracujVysledky = (d, najdene) => {
        logInfo(`Search result: "${d?.slice(0, 60)}" → ${najdene.length} torrentov`);
        for (const t of najdene) {
            if (!videnieTorrentIds.has(t.id)) {
                torrenty.push(t);
                videnieTorrentIds.add(t.id);
            }
        }
        if (d === csfdLink && najdene.length > 0) {
            logSuccess(`Nájdené cez ČSFD Link. Mám ${torrenty.length} výsledkov.`);
            uspesneNajdeneCezCsfd = true;
        }
    };

    if (sktDirectId) {
        logInfo(`Direct SKT stream lookup for ID: ${sktDirectId}`);
        const cached = sktMetaCache.get(rawId);
        torrenty.push({
            name: cached?.name || "SKTorrent",
            id: sktDirectId,
            category: cached?.category || "Sport",
            size: cached?.size || "?",
            seeds: cached?.seeds || 0,
            downloadUrl: `${BASE_URL}/torrent/download.php?id=${sktDirectId}`
        });
        videnieTorrentIds.add(sktDirectId);
    } else {
        // ── BATCH 1: CSFD URL + primárny názov (max 2 query, paralelne) ──
        // SKTorrent search je čistý substring search — primárny názov (bez diakritiky)
        // nájde pack aj epizódy, správnu epizódu vyberie client-side filter.
        const primarnyBezDia = odstranDiakritiku(unikatneNazvy[0] || "").trim();
        const prveDotazy = [];
        if (csfdLink) prveDotazy.push(csfdLink);
        if (primarnyBezDia) prveDotazy.push(primarnyBezDia);

        const vysledkyBatch = await Promise.all(prveDotazy.map(d =>
            hladatTorrenty(d, userAxios, 2, userKey)
        ));
        prveDotazy.forEach((d, i) => spracujVysledky(d, vysledkyBatch[i] || []));

        // ── FALLBACK: len ak batch 1 nič nenašiel ──
        // Kratšie názvy (3 slová) a ostatné jazykové varianty — ale NIE epizódové tagy
        // (sú vždy podmnožina základného názvu) a nie generické jednoslovné query
        // (vracajú garbage — napr. "Odysea" → 36 irelevantných torrentov).
        if (torrenty.length === 0) {
            const fallback = [];
            unikatneNazvy.forEach(z => {
                const bezDia = odstranDiakritiku(z).trim();
                if (!bezDia || bezDia === primarnyBezDia) return;
                fallback.push(bezDia);
                const kratky = skratNazov(bezDia, 3);
                if (kratky && kratky !== bezDia) fallback.push(kratky);
            });
            // kratší variant primárneho názvu ako prvý (ak je dlhý)
            const primKratky = skratNazov(primarnyBezDia, 3);
            if (primKratky && primKratky !== primarnyBezDia) fallback.unshift(primKratky);

            const unikFallback = [...new Set(fallback)].slice(0, 4); // max 4, nech nepreťažíme tracker
            const vysledkyFb = await Promise.all(unikFallback.map(d =>
                hladatTorrenty(d, userAxios, 2, userKey)
            ));
            unikFallback.forEach((d, i) => spracujVysledky(d, vysledkyFb[i] || []));
        }

        // Name filter preskočíme LEN ak CSFD query reálne našla torrenty (sú to presné
        // zhody). Ak CSFD link existuje ale query nič nevrátila, filter beží — inak by
        // cez generické fallback query prešiel garbage (iné filmy s podobným názvom).
        if (!uspesneNajdeneCezCsfd) {
            const predNameFiltrom = torrenty.length;
            torrenty = torrenty.filter(t => {
                let rawName = odstranDiakritiku(t.name.toLowerCase()).replace(/^stiahni si\s*/i, "").trim();
                const prefixRe = /^(?:filmy|film|serialy|serial|seriál|seria|serie|dokumenty|dokument|tv|kreslene|kreslené|anime)\b/i;
                const junkRe = /^(?:\s+|[-–_|/]+|\[[^\]]*]|\([^)]+\)|1080p|720p|2160p|4k|hdr|web[-\s]?dl|webrip|brrip|bluray|dvdrip|tvrip|cz|sk|en)\b/i;
                
                let prev;
                do {
                    prev = rawName;
                    rawName = rawName.replace(prefixRe, "").trim();
                    rawName = rawName.replace(junkRe, "").trim();
                } while (rawName !== prev);

                for (const nazov of unikatneNazvy) {
                    const hl = odstranDiakritiku(nazov.toLowerCase()).trim();
                    if (!hl) continue;
                    const escaped = hl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                    if (new RegExp(`\\b${escaped}\\b`, "i").test(rawName)) return true;
                }
                return false;
            });
            logInfo(`Title accuracy filter complete. Remaining: ${torrenty.length} (filtered out ${predNameFiltrom - torrenty.length} unrelated titles)`);
        }
    }

    if (seria !== undefined) {
        logInfo(`Filtering series torrents for S${seria} E${epizoda}...`);
        const predFiltrom = torrenty.length;
        torrenty = torrenty.filter(t => torrentSedisSeriou(t.name, seria) && torrentSediSEpizodou(t.name, seria, epizoda));
        logInfo(`Series filter complete. Remaining: ${torrenty.length} (filtered out ${predFiltrom - torrenty.length})`);
    }

    const execLimit = pLimit(5);
    logInfo(`Creating streams for ${torrenty.length} torrents (Max concurrency: 5)...`);
    
    // POSIELAME `metaInfo` do `vytvoritStream`
    let streamy = (await Promise.all(
        torrenty.map(t => execLimit(() => vytvoritStream(t, seria, epizoda, userAxios, metaInfo, userConfig)))
    )).filter(Boolean);

        // ── DEBRID REŽIM (TorBox / Real-Debrid) ──
        const debridProvider = userConfig.debridProvider || (userConfig.torbox ? 'torbox' : '');
        const debridApiKey = debridProvider === 'torbox' ? userConfig.torbox : (debridProvider === 'realdebrid' ? userConfig.realdebrid : null);

        if (debridProvider && debridApiKey) {
            const providerLabel = debridProvider === 'torbox' ? 'TorBox' : 'Real-Debrid';
            const providerPrefix = debridProvider === 'torbox' ? 'TB' : 'RD';
            logInfo(`${providerLabel} enabled. Preparing streams for ${providerLabel} playback...`);
            
            const hasheKONTROLA = streamy.map(s => s.infoHash).filter(Boolean);
            const debridCache = await overitDebridCache(hasheKONTROLA, debridApiKey, debridProvider);

            streamy = streamy.map(stream => {
                const hash = stream.infoHash.toLowerCase();
                if (!precacheIdMap.has(hash)) {
                    precacheIdMap.set(hash, id); // hash → pôvodné stream ID (pre pre-cache z /play)
                    if (precacheIdMap.size > 3000) precacheIdMap.delete(precacheIdMap.keys().next().value);
                }
                const jeCached = debridCache[hash] === true;
                const jeRdBlocked = stream._sortRdBlocked === 1;
                const staraKategoria = stream.name.split("\n")[1] || "";
                const proxySeria = seria || 0;
                const proxyEpizoda = epizoda || 0;
                const sortText = `${staraKategoria} ${stream.title || ""}`;

                // Prefix podľa stavu (❌ len pre Real-Debrid)
                let streamPrefix;
                if (jeRdBlocked && debridProvider === 'realdebrid') {
                    streamPrefix = `[${providerPrefix} ❌]`;
                } else if (jeCached) {
                    streamPrefix = `[${providerPrefix} ⚡]`;
                } else {
                    streamPrefix = `[${providerPrefix} ⏳]`;
                }

                let finalStream = {
                    name: `${streamPrefix} SKT\n${staraKategoria}`,
                    title: stream.title,
                    type: vlastnyTyp,
                    behaviorHints: stream.behaviorHints,
                    _sortCached: jeCached ? 1 : 0,
                    _sortRdBlocked: jeRdBlocked ? 1 : 0,
                    _sortDub: stream.isDub ? 1 : 0,
                    _sortDubLang: stream.isDub ? (stream.dubLang || '') : '',
                    _sortHdr: stream._sortHdr || '',
                    _sortSource: stream._sortSource || 'neznámy',
                    _sortName: stream._sortName || '',
                    _sortCategory: stream._sortCategory || '',
                    _sortZaner: stream._sortZaner || '',
                    _sortQuality: getQualityRank(sortText),
                    _sortSize: getSizeBytes(sortText),
                    _sortSeeds: stream.seeds || 0
                };

                const safeName = (stream.fileName || "video.mkv").split('/').join('|');
                if (jeCached) {
                    // Cached: cez /play – okamžité prehratie
                    finalStream.url = `${PUBLIC_URL}/${config}/play/${hash}/${proxySeria}/${proxyEpizoda}/${encodeURIComponent(safeName)}`;
                } else {
                    // Necachovaný: cez /download – nahranie do debridu, info video
                    finalStream.url = `${PUBLIC_URL}/${config}/download/${hash}/${stream.sktId}`;
                }
                return finalStream;
            });

            const cachedOnly = userConfig.cachedOnly === true;
            if (cachedOnly) {
                streamy = streamy.filter(s => s._sortCached === 1);
            }
        }

        // ── P2P REŽIM (bez debridu) ──
        if ((!debridProvider || !debridApiKey) && streamy.length > 0) {
            logInfo("TorBox not configured. Using P2P mode (WebTorrent).");
            streamy = streamy.map(stream => {
                const staraKategoria = stream.name.split("\n")[1] || "";
                const sortText = `${staraKategoria} ${stream.title || ""}`;
                const seeds = stream.seeds || 0;

                let bufferHint = "";
                if (seeds < 5) {
                    bufferHint = "\n⚠️ Málo seedov — zapauzuj na 1-2 min na načítanie do cache";
                } else if (seeds >= 15) {
                    bufferHint = "\n⚡ Rýchly P2P stream";
                }

                return {
                    name: `SKT\n${staraKategoria}`,
                    title: `${stream.title}${bufferHint}`,
                    infoHash: stream.infoHash,
                    fileIdx: stream.fileIdx,
                    sources: (stream.sources && stream.sources.length > 0) ? stream.sources : undefined,
                    behaviorHints: stream.behaviorHints,
                    _sortCached: 0,
                    _sortDub: stream.isDub ? 1 : 0,
                    _sortDubLang: stream.isDub ? (stream.dubLang || '') : '',
                    _sortName: stream._sortName || '',
                    _sortCategory: stream._sortCategory || '',
                    _sortHdr: stream._sortHdr || '',
                    _sortSource: stream._sortSource || 'neznámy',
                    _sortQuality: getQualityRank(sortText),
                    _sortSize: getSizeBytes(sortText),
                    _sortSeeds: seeds
                };
            });
        }

        // ── Ak nie sú žiadne streamy ──
        if (streamy.length === 0) {
            logInfo("No streams found. Returning empty list.");
            return res.json({ streams: [] });
        }

        // ── FILTROVANIE (Meteor-štýl) ──

        // 1. Cached Only filter — pre debrid režim už ošetrený vyššie; pre P2P nedáva zmysel
        const userRes = userConfig.res;
        if (userRes && Array.isArray(userRes) && userRes.length > 0 && userRes.length < 4) {
            const allowedQualities = [];
            if (userRes.includes('2160p')) allowedQualities.push(4);
            if (userRes.includes('1080p')) allowedQualities.push(3);
            if (userRes.includes('720p')) allowedQualities.push(2);
            if (userRes.includes('sd')) allowedQualities.push(1);
            if (allowedQualities.length > 0) {
                streamy = streamy.filter(s => allowedQualities.includes(s._sortQuality));
            }
        }

        
        // 2b. HDR/DV/HEVC filter (chips: hdr, dv, hevc, atmos)
        const userHdr = userConfig.hdr;
        if (userHdr && Array.isArray(userHdr) && userHdr.length > 0 && userHdr.length < 4) {
            streamy = streamy.filter(s => {
                const hdr = s._sortHdr || '';
                if (!hdr) return true; // streamy bez HDR metadát prejdú cez filter
                return userHdr.some(function(h) { return hdr.includes(h); });
            });
        }

        // 2c. 18+ filter (chips: hide)
        const userAdult = userConfig.adult;
        if (userAdult && Array.isArray(userAdult) && userAdult.includes('hide')) {
            streamy = streamy.filter(s => {
                const name = (s._sortName || '').toLowerCase();
                const cat = (s._sortCategory || '').toLowerCase();
                const zaner = (s._sortZaner || '').toLowerCase();
                const adultKeywords = ['erotick','porn','xxx','adult','18+','sex','onlyfans','erotika'];
                // Kategória xXx (aj "xXx hry (18+)") a žáner Eroticky — podľa sktorrent.eu
                if (cat.includes('xxx') || zaner.includes('erotick')) return false;
                // Názov torrentu obsahuje adult výrazy
                for (let ki = 0; ki < adultKeywords.length; ki++) {
                    if (name.includes(adultKeywords[ki])) return false;
                }
                return true;
            });
        }

        // 2d. Source type filter (chips: webdl, bluray, hdtv, dvdrip, webrip, hdrip, ppv, remux, cam)
        const userSource = userConfig.source;
        if (userSource && Array.isArray(userSource) && userSource.length > 0 && userSource.length < 12) {
            streamy = streamy.filter(s => {
                const src = (s._sortSource || 'neznámy').toLowerCase();
                // Unknown source type always passes through
                if (src === 'neznámy') return true;
                return userSource.some(function(us) { return src.includes(us); });
            });
        }

        // 3. Min seeds filter
        const minSeedsVal = parseInt(userConfig.minSeeds || '0');
        if (minSeedsVal > 0) {
            streamy = streamy.filter(s => (s._sortSeeds || 0) >= minSeedsVal);
        }

        // 4. Max size filter (in GB)
        const maxSizeVal = parseFloat(userConfig.maxSize || '0');
        if (maxSizeVal > 0) {
            const maxSizeBytes = maxSizeVal * 1024 * 1024 * 1024;
            streamy = streamy.filter(s => s._sortSize > 0 && s._sortSize <= maxSizeBytes);
        }

        // 5. Language preference — iba priorita, nefiltruje
        const userLangs = userConfig.lang;

        // ── RADENIE (podľa používateľského sort order) ──
        const sortOrder = userConfig.sort;
        if (sortOrder && Array.isArray(sortOrder) && sortOrder.length > 0) {
            streamy.sort((a, b) => {
                for (let i = 0; i < sortOrder.length; i++) {
                    const criterion = sortOrder[i];
                    let cmp = 0;

                    if (criterion === 'cached') {
                        const cacheLevel = (s) => {
                            if (debridProvider === 'realdebrid' && s._sortRdBlocked === 1) return -1; // RD blocked → najnižšia priorita
                            return s._sortCached || 0;              // cached=1, not cached=0
                        };
                        cmp = cacheLevel(b) - cacheLevel(a);
                    } else if (criterion === 'quality') {
                        cmp = (b._sortQuality || 0) - (a._sortQuality || 0);
                    } else if (criterion === 'lang') {
                        function langScore(s) {
                            if (!userLangs || !Array.isArray(userLangs) || userLangs.length === 0 || userLangs.length >= 4) return 0;
                            const dubLang = s._sortDubLang || '';
                            const isDub = s._sortDub === 1;
                            if (userLangs.includes('multi')) return 1;
                            if (userLangs.includes('sk') && (dubLang === 'sk' || dubLang === 'cz')) return 1;
                            if (userLangs.includes('cz') && (dubLang === 'cz' || dubLang === 'sk')) return 1;
                            if (userLangs.includes('en') && (!isDub || dubLang === 'en')) return 1;
                            return 0;
                        }
                        cmp = langScore(b) - langScore(a);
                    } else if (criterion === 'seeds') {
                        cmp = (b._sortSeeds || 0) - (a._sortSeeds || 0);
                    } else if (criterion === 'size') {
                        cmp = (b._sortSize || 0) - (a._sortSize || 0);
                    }

                    if (cmp !== 0) return cmp;
                }
                return 0;
            });
        }

        // 6. Max per resolution limit (po sorte, pred cleanup)
        // POZOR: Zachováva sort order — neprehadzuje kvality!
        const maxPerResVal = parseInt(userConfig.maxPerRes || '0');
        if (maxPerResVal > 0) {
            const taken = {};
            const result = [];
            for (let i = 0; i < streamy.length; i++) {
                const s = streamy[i];
                const q = s._sortQuality || 0;
                if (!taken[q]) taken[q] = 0;
                if (taken[q] < maxPerResVal) {
                    taken[q]++;
                    result.push(s);
                }
            }
            streamy = result;
        }

        // ── PRECACHE ĎALŠEJ EPIZÓDY: rozhodovanie pre vnútorný request ──
        // Trigger NIE JE tu (pri prehliadaní streamov), ale v /play handleri:
        // pre-cache sa spúšťa až keď sa epizóda reálne začne prehrávať.
        // Tento blok beží len pri internom requeste s ?precache=1 a rozhodne,
        // či treba začať sťahovať najlepší uncached torrent do debridu.
        if (req.query.precache === '1' && seria !== undefined && epizoda !== undefined && debridProvider && debridApiKey && streamy.length > 0) {
            if (streamy.some(s => s._sortCached === 1)) {
                logInfo(`[PRECACHE] S${seria}E${epizoda}: netreba sťahovať — cached stream už existuje`);
            } else {
                // Žiadna cached verzia — vyberieme najlepší uncached podľa user sort.
                // Pre Real-Debrid preskakujeme názvy, ktoré RD blokuje (451). Ak sú
                // blokované všetky, kandidat = undefined → nič sa nesťahuje (fallback
                // by stiahol torrent, ktorý RD aj tak odmietne).
                const kandidat = streamy.find(s => s._sortCached === 0 && !(debridProvider === 'realdebrid' && s._sortRdBlocked === 1));
                if (kandidat && kandidat.url) {
                    const nazovKandidata = (kandidat.title || '').split('\n')[0] || 'neznámy';
                    logInfo(`[PRECACHE] S${seria}E${epizoda}: žiadny cached stream, sťahujem najlepší uncached: ${nazovKandidata}`);
                    // Klik na ⏳ stream by zavolal kandidat.url (cez PUBLIC_URL).
                    // Interne ho smerujeme na loopback, nech request nejde cez tunel.
                    const lokalnaUrl = kandidat.url.replace(PUBLIC_URL, `http://127.0.0.1:${PORT}`);
                    axios.get(lokalnaUrl, { timeout: 30000, maxRedirects: 0, validateStatus: () => true })
                        .then(() => logSuccess(`[PRECACHE] S${seria}E${epizoda}: /download vybavené`))
                        .catch(e => logInfo(`[PRECACHE] S${seria}E${epizoda}: /download = ${e.message}`));
                } else {
                    logInfo(`[PRECACHE] S${seria}E${epizoda}: uncached streamy sú, ale žiadny vhodný kandidát`);
                }
            }
        }

        // Odstrániť interné _sort polia
        streamy = streamy.map(({ _sortCached, _sortRdBlocked, _sortDub, _sortDubLang, _sortName, _sortCategory, _sortZaner, _sortHdr, _sortSource, _sortQuality, _sortSize, _sortSeeds, ...rest }) => rest);

        // 7. Max results limit
        const maxResultsVal = parseInt(userConfig.maxResults || '0');
        if (maxResultsVal > 0 && streamy.length > maxResultsVal) {
            streamy = streamy.slice(0, maxResultsVal);
        }

        const trvanie = Date.now() - startCas;
        logSuccess(`Stream request finished in ${trvanie}ms. Returning ${streamy.length} streams to Stremio.`);

        // Cache-Control len pre debrid režim
        if (debridProvider && debridApiKey) {
            const maUncachedStreamy = streamy.some(s => s.name && s.name.includes("⏳"));
            const cacheMaxAge = maUncachedStreamy ? 60 : 3600;
            res.setHeader('Cache-Control', `max-age=${cacheMaxAge}, stale-while-revalidate=${cacheMaxAge}, stale-if-error=${cacheMaxAge}`);
        }

        return res.json({ streams: streamy });
    }));


// =========================================================================
// TORBOX PROXY ROUTER
// =========================================================================
app.get('/:config/play/:hash/:seria/:epizoda/:fileName', asyncRoute(async (req, res) => {
    const { hash, seria, epizoda, config } = req.params;
    const decodedFileName = decodeURIComponent(req.params.fileName || "").replace(/\|/g, "/");
    logApi(`Play Request: Hash: ${hash} | S${seria}E${epizoda} | File: ${decodedFileName}`);

    const userConfig = decodeConfig(config);
    if (!userConfig) return res.status(400).send("Chyba konfigurácie.");

    const debridProvider = userConfig.debridProvider || (userConfig.torbox ? 'torbox' : '');
    const debridApiKey = debridProvider === 'torbox' ? userConfig.torbox : (debridProvider === 'realdebrid' ? userConfig.realdebrid : null);

    if (!debridApiKey) {
        return res.status(400).send("Chýba debrid API kľúč.");
    }

    // PRECACHE ĎALŠEJ EPIZÓDY — /play znamená, že sa epizóda reálne začala
    // prehrávať (cached ⚡ stream). Naplánujeme pre-cache nasledujúcej epizódy.
    spustitPrecacheDalsejEpizody(userConfig, debridProvider, debridApiKey, hash, seria, epizoda, config);

    if (debridProvider === 'torbox') {
        return handleTorboxPlay(req, res, hash, seria, epizoda, decodedFileName, userConfig, debridApiKey);
    } else if (debridProvider === 'realdebrid') {
        return handleRealDebridPlay(req, res, hash, decodedFileName, debridApiKey);
    }

    return res.status(400).send("Neznámy debrid provider.");
}));

async function handleTorboxPlay(req, res, hash, seria, epizoda, decodedFileName, userConfig, TORBOX_API_KEY) {
    logApi(`TorBox Play Request: Hash: ${hash} | S${seria}E${epizoda} | File: ${decodedFileName}`);
    try {
        const tbTorrentsRes = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
            headers: { Authorization: `Bearer ${TORBOX_API_KEY}` },
            timeout: 10000
        });

        let torrentId = null;
        let najdenyTorrentObj = null;

        if (tbTorrentsRes.data && tbTorrentsRes.data.data) {
            const zoznam = Array.isArray(tbTorrentsRes.data.data) ? tbTorrentsRes.data.data : [tbTorrentsRes.data.data];
            najdenyTorrentObj = zoznam.find(t => t.hash && t.hash.toLowerCase() === hash.toLowerCase());
            if (najdenyTorrentObj) {
                torrentId = najdenyTorrentObj.id;
            }
        }

        if (!torrentId) {
            const formData = new FormData();
            formData.append("magnet", `magnet:?xt=urn:btih:${hash}`);
            formData.append("seed_instantly", "true");

            const addRes = await axios.post("https://api.torbox.app/v1/api/torrents/createtorrent", formData, {
                headers: { Authorization: `Bearer ${TORBOX_API_KEY}`, ...formData.getHeaders() },
                timeout: 15000
            });

            torrentId = addRes.data?.data?.torrent_id;

            await new Promise(r => setTimeout(r, 3000));
            const tbRefreshRes = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
                headers: { Authorization: `Bearer ${TORBOX_API_KEY}` },
                timeout: 10000
            });

            if (tbRefreshRes.data && tbRefreshRes.data.data) {
                const zoznamRefresh = Array.isArray(tbRefreshRes.data.data) ? tbRefreshRes.data.data : [tbRefreshRes.data.data];
                najdenyTorrentObj = zoznamRefresh.find(t => t.id === torrentId);
            }
        }

        let spravneFileId = null;

        if (najdenyTorrentObj && najdenyTorrentObj.files) {
            const videoSbory = najdenyTorrentObj.files.filter(f => /\.(mp4|mkv|avi|m4v)$/i.test(f.name));

            logInfo(`[TORBOX] Hľadám súbor medzi ${videoSbory.length} video súbormi. Hľadaný názov: "${decodedFileName}"`);
            videoSbory.slice(0, 5).forEach(f => logInfo(`  → ID: ${f.id} | Name: ${f.name}`));

            // 1. POKUS: zhoda podľa názvu súboru (najpresnejšie)
            if (decodedFileName) {
                const zhoda = videoSbory.find(f =>
                    f.name === decodedFileName ||
                    f.name.endsWith(decodedFileName) ||
                    decodedFileName.endsWith(f.name) ||
                    // Porovnanie len samotného názvu súboru (bez adresára)
                    f.name.split("/").pop() === decodedFileName.split("/").pop()
                );
                if (zhoda) {
                    spravneFileId = zhoda.id;
                    logSuccess(`[TORBOX PROXY] Zhoda podľa názvu → ID: ${zhoda.id} | ${zhoda.name}`);
                }
            }

            // 2. FALLBACK: regex ak zhoda podľa názvu zlyhala
            if (spravneFileId === null) {
                logWarn(`[TORBOX PROXY] Zhoda podľa názvu zlyhala, skúšam regex...`);
                const epCislo = parseInt(epizoda);
                const epStr = String(epCislo).padStart(2, "0");
                const seriaStr = String(seria).padStart(2, "0");

                const epRegexy = [
                    new RegExp(`[\\\\/](?:\\d+\\.\\s*s[eé]rie[\\\\/])?0*${epCislo}[\\s._-][^\\\\/]*\\.(?:mp4|mkv|avi|m4v)$`, "i"),
                    new RegExp(`\\bS${seriaStr}[._-]?E${epStr}\\b`, "i"),
                    new RegExp(`\\b${seria}x${epStr}\\b`, "i"),
                    new RegExp(`\\b${seriaStr}x${epStr}\\b`, "i"),
                    new RegExp(`S${seriaStr}[._-]?E${epStr}(?![0-9])`, "i"),
                    new RegExp(`Ep(?:isode)?[._\\s]*0*${epCislo}\\b`, "i"),
                    new RegExp(`\\bE${epStr}\\b`, "i"),
                    new RegExp(`(?:^|[\\\\/])[\\s._-]*0*${epCislo}[\\s._-].*\\.(?:mp4|mkv|avi|m4v)$`, "i")
                ];

                for (const reg of epRegexy) {
                    const zhoda = videoSbory.find(f => reg.test(f.name));
                    if (zhoda) {
                        spravneFileId = zhoda.id;
                        logSuccess(`[TORBOX PROXY] Regex zhoda → ID: ${zhoda.id} | ${zhoda.name}`);
                        break;
                    }
                }
            }

            // 3. POSLEDNÝ FALLBACK: ak máme len 1 súbor
            if (spravneFileId === null) {
                if (videoSbory.length === 1) {
                    spravneFileId = videoSbory[0].id;
                    logWarn(`[TORBOX PROXY] Len 1 súbor, púšťam: ${videoSbory[0].name}`);
                } else {
                    logError(`[TORBOX PROXY] Zlyhanie! Neviem určiť správny súbor.`);
                    return res.status(404).send("Torbox nevie identifikovať súbor epizódy.");
                }
            }
        }

        if (spravneFileId === null) spravneFileId = 0;

        const downloadRes = await axios.get("https://api.torbox.app/v1/api/torrents/requestdl", {
            params: {
                token: TORBOX_API_KEY,
                torrent_id: torrentId,
                file_id: spravneFileId,
                zip_link: false
            },
            headers: { Authorization: `Bearer ${TORBOX_API_KEY}` },
            timeout: 15000
        });

const directLink = downloadRes.data?.data;
if (directLink) {
    logSuccess(`[TORBOX PROXY] Redirectujem na TorBox CDN URL`);
    res.redirect(302, directLink);
} else {
    res.status(404).send("Torbox nevrátil URL.");
}
} catch (err) {
    logError("TorBox play proxy error", err);
    res.status(500).send("Chyba proxy servera.");
}
}

async function handleRealDebridPlay(req, res, hash, decodedFileName, RD_API_KEY) {
    logApi(`[RD PLAY] priame RD API pre hash: ${hash}`);
    try {
        // 1. Pridáme magnet (ak už existuje, error_code 33 = nájdeme ho v liste)
        let torrentId;
        try {
            const magnetId = await rdAddMagnet(RD_API_KEY, hash);
            torrentId = magnetId.id;
            logApi(`[RD PLAY] Magnet pridaný: ${torrentId}`);
        } catch (addErr) {
            if (addErr.response?.data?.error_code === 33) {
                // Torrent už existuje — nájdeme ho v userovom liste
                logApi(`[RD PLAY] Magnet už existuje, hľadám v liste...`);
                const listItems = await rdListTorrents(RD_API_KEY, 1, 100);
                const existing = listItems.find(t => t.hash?.toLowerCase() === hash.toLowerCase());
                if (!existing) {
                    logError(`[RD PLAY] Torrent s hash ${hash.substring(0,12)}... nenašiel v liste`);
                    return res.redirect(302, '/info-video');
                }
                torrentId = existing.id;
                logApi(`[RD PLAY] Nájdený existujúci torrent: ${torrentId} (status: ${existing.status})`);
            } else {
                throw addErr;
            }
        }

        // 2. Počkáme na magnet conversion (poll max 15x po 500ms)
        let info;
        for (let i = 0; i < 15; i++) {
            info = await rdTorrentInfo(RD_API_KEY, torrentId);
            if (info.status === 'waiting_files_selection') break;
            if (info.status === 'downloaded' || info.status === 'downloading') break;
            await new Promise(r => setTimeout(r, 500));
        }

        if (!info || info.status === 'magnet_error' || info.status === 'error') {
            logError(`[RD PLAY] Magnet conversion failed: ${info?.status}`);
            return res.redirect(302, '/info-video');
        }

        // 3. Vyberieme video súbory
        const videoFiles = (info.files || []).filter(f => /\.(mp4|mkv|avi|m4v|mov)$/i.test(f.path || ''));
        const fileIds = videoFiles.length > 0
            ? videoFiles.map(f => f.id).join(',')
            : (info.files || []).map(f => f.id).join(',');

        if (fileIds) {
            await rdSelectFiles(RD_API_KEY, torrentId, fileIds);
        }

        // 4. Skontrolujeme či je cached (progress 100 = torrent je hotový)
        info = await rdTorrentInfo(RD_API_KEY, torrentId);
        // Po selectFiles potrebuje RD chvíľu, kým prejde na status downloaded —
        // aj keď je torrent už hotový (progress 100, status ešte downloading).
        // Čakáme max 10 s LEN ak je progress 100; ak sa reálne sťahuje
        // (progress < 100), nejdeme čakať a rovno presmerujeme na info-video.
        if (info.progress === 100 && info.status !== 'downloaded') {
            for (let i = 0; i < 10 && info.status !== 'downloaded'; i++) {
                await new Promise(r => setTimeout(r, 1000));
                info = await rdTorrentInfo(RD_API_KEY, torrentId);
            }
        }

        if (info.progress === 100 && info.status === 'downloaded') {
            // 5. Nájdeme správny link a unrestrict
            const fileName = decodedFileName.split('/').pop() || '';
            let targetLink = null;

            if (info.links && info.links.length > 0) {
                // Ak máme file-level linky, vyberieme správny
                const selectedFiles = info.files.filter(f => f.selected);
                if (selectedFiles.length === info.links.length) {
                    const targetFileIdx = selectedFiles.findIndex(f =>
                        (f.path || '').includes(fileName) || fileName.includes((f.path || '').split('/').pop())
                    );
                    targetLink = targetFileIdx >= 0 ? info.links[targetFileIdx] : info.links[0];
                } else {
                    targetLink = info.links[0];
                }
            }

            if (targetLink) {
                const unrestricted = await rdUnrestrictLink(RD_API_KEY, targetLink);
                if (unrestricted && unrestricted.download) {
                    // Uložíme do cache
                    if (!rdCacheLoaded) nacitatRdCache();
                    rdCache[hash.toLowerCase()] = { cached_at: Date.now() };
                    ulozitRdCache();
                    logSuccess(`[RD PLAY] Hash ${hash.substring(0,12)} uložený do cache + redirect`);
                    return res.redirect(302, unrestricted.download);
                }
            }
        }

        logApi(`[RD PLAY] Torrent nie je cached (${info?.status}), redirect na info-video`);
        return res.redirect(302, '/info-video');

    } catch (err) {
        const status = err.response?.status;
        const rdErrCode = err.response?.data?.error_code;
        const isBlocked = status === 451 || status === 503 || err.response?.data?.code === 'UNAVAILABLE_FOR_LEGAL_REASONS' || rdErrCode === 35;

        if (isBlocked) {
            const dekNazov = decodeURIComponent(decodedFileName || '').split('/').pop() || 'neznámy';
            logError(`[RD PLAY] RD blokuje súbor: ${dekNazov}`);
            return res.status(500).send('Real-Debrid blokuje tento súbor (infringing_file). Skús iný zdroj.');
        }

        logError(`[RD PLAY] RD API chyba`, err);
        if (err.response) {
            logError(`[RD PLAY] HTTP ${status} - ${JSON.stringify(err.response.data).substring(0, 200)}`);
        }
        return res.status(500).send(`Chyba Real-Debrid: ${err.message}`);
    }
}




app.get("/:config/download/:hash/:sktId", asyncRoute(async (req, res) => {
    const { hash, sktId, config } = req.params;

    const userConfig = decodeConfig(config);
    if (!userConfig) return res.status(400).send("Chyba Configu");

    const debridProvider = userConfig.debridProvider || (userConfig.torbox ? 'torbox' : '');
    const debridApiKey = debridProvider === 'torbox' ? userConfig.torbox : (debridProvider === 'realdebrid' ? userConfig.realdebrid : null);

    if (!debridApiKey) return res.status(400).send("Chýba debrid API kľúč.");

    try {
        logApi(`Downloading torrent via magnet: magnet:?xt=urn:btih:${hash}`);

        if (debridProvider === 'torbox') {
            // ========== TORBOX DOWNLOAD (nezmenené) ==========
            const formData = new FormData();
            formData.append("seed_instantly", "true");
            formData.append("allow_zip", "false");
            formData.append("seed", "2");
            formData.append("magnet", `magnet:?xt=urn:btih:${hash}`);

            const createRes = await axios.post("https://api.torbox.app/v1/api/torrents/createtorrent", formData, {
                headers: { "Authorization": `Bearer ${debridApiKey}`, ...formData.getHeaders() },
                timeout: 15000
            });

            const tbData = createRes.data?.data;
            let torrentId = tbData?.torrent_id ?? tbData?.id ?? tbData?.queued_id ?? null;
            const bolQueued = !!tbData?.queued_id;

            if (torrentId) {
                try {
                    const dlRes = await axios.get("https://api.torbox.app/v1/api/torrents/requestdl", {
                        params: { token: debridApiKey, torrent_id: torrentId, zip_link: false },
                        headers: { Authorization: `Bearer ${debridApiKey}` },
                        timeout: 10000
                    });
                    const streamUrl = dlRes.data?.data;
                    if (streamUrl) {
                        logSuccess(`[TB DOWNLOAD] Torrent je rovno hrateľný, redirectujem na stream`);
                        return res.redirect(302, streamUrl);
                    }
                    logApi(`[TB DOWNLOAD] Torrent nahratý, čaká na stiahnutie`);
                } catch (dlErr) {
                    logApi(`[TB DOWNLOAD] requestdl zlyhal: ${dlErr.message}`);
                }
            }

            if (bolQueued || (!torrentId && createRes.data?.error === 'DUPLICATE_ITEM')) {
                try {
                    const mylistRes = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
                        headers: { Authorization: `Bearer ${debridApiKey}` },
                        timeout: 8000,
                        params: { bypass_cache: true }
                    });

                    if (mylistRes.data?.success && Array.isArray(mylistRes.data.data)) {
                        const finishedSeeding = mylistRes.data.data
                            .filter(t => t.download_finished && t.active)
                            .sort((a, b) => (a.download_finished_at || 0) - (b.download_finished_at || 0));

                        if (finishedSeeding.length > 0) {
                            const toStop = finishedSeeding[0];
                            await axios.post("https://api.torbox.app/v1/api/torrents/controltorrent",
                                { torrent_id: String(toStop.id), operation: "stop_seeding" },
                                { headers: { Authorization: `Bearer ${debridApiKey}` }, timeout: 8000 }
                            );
                            logApi(`[TB SLOTS] Zastavený seeding torrentu ${toStop.id}`);

                            const queuedId = torrentId || tbData?.queued_id;
                            if (queuedId) {
                                await new Promise(r => setTimeout(r, 2000));

                                if (bolQueued) {
                                    await axios.post("https://api.torbox.app/v1/api/queued/controlqueued",
                                        { queued_id: Number(queuedId), operation: "start" },
                                        { headers: { Authorization: `Bearer ${debridApiKey}`, "Content-Type": "application/json" }, timeout: 10000 }
                                    );
                                    logApi(`[TB SLOTS] Spustený queued torrent ${queuedId}`);
                                } else {
                                    await axios.post("https://api.torbox.app/v1/api/torrents/controltorrent",
                                        { torrent_id: String(queuedId), operation: "resume" },
                                        { headers: { Authorization: `Bearer ${debridApiKey}` }, timeout: 10000 }
                                    );
                                    logApi(`[TB SLOTS] Resume queued torrent ${queuedId}`);
                                }
                            }
                        } else {
                            logApi(`[TB SLOTS] Žiadny hotový seeding torrent na uvoľnenie`);
                        }
                    }
                } catch (slotErr) {
                    logWarn(`[TB SLOTS] Chyba pri uvoľňovaní slotu: ${slotErr.message}`);
                }
            }
        } else if (debridProvider === 'realdebrid') {
            // ========== REAL-DEBRID DOWNLOAD (priame RD API) ==========
            logApi(`[RD DOWNLOAD] priame RD API pre hash: ${hash}`);

            let torrentId;
            try {
                const magnetId = await rdAddMagnet(debridApiKey, hash);
                torrentId = magnetId.id;
                logApi(`[RD DOWNLOAD] Magnet pridaný: ${torrentId}`);
            } catch (addErr) {
                if (addErr.response?.data?.error_code === 33) {
                    logApi(`[RD DOWNLOAD] Magnet už existuje, hľadám v liste...`);
                    const listItems = await rdListTorrents(debridApiKey, 1, 100);
                    const existing = listItems.find(t => t.hash?.toLowerCase() === hash.toLowerCase());
                    if (!existing) {
                        logError(`[RD DOWNLOAD] Torrent s hash ${hash.substring(0,12)}... nenašiel v liste`);
                        return res.redirect(302, '/info-video');
                    }
                    torrentId = existing.id;
                    logApi(`[RD DOWNLOAD] Nájdený existujúci torrent: ${torrentId} (status: ${existing.status})`);
                } else {
                    throw addErr;
                }
            }

            // Počkáme na magnet conversion
            let info;
            for (let i = 0; i < 15; i++) {
                info = await rdTorrentInfo(debridApiKey, torrentId);
                if (info.status === 'waiting_files_selection') break;
                if (info.status === 'downloaded' || info.status === 'downloading') break;
                await new Promise(r => setTimeout(r, 500));
            }

            if (!info || info.status === 'magnet_error' || info.status === 'error') {
                logError(`[RD DOWNLOAD] Magnet conversion failed: ${info?.status}`);
                return res.redirect(302, '/info-video');
            }

            // Vyberieme video súbory
            const videoFiles = (info.files || []).filter(f => /\.(mp4|mkv|avi|m4v|mov)$/i.test(f.path || ''));
            const fileIds = videoFiles.length > 0
                ? videoFiles.map(f => f.id).join(',')
                : (info.files || []).map(f => f.id).join(',');

            if (fileIds) {
                await rdSelectFiles(debridApiKey, torrentId, fileIds);
            }

            info = await rdTorrentInfo(debridApiKey, torrentId);
            // Keď je torrent hotový (progress 100), RD prejde na status downloaded
            // behom pár sekúnd — počkáme max 10 s, inak info-video.
            if (info.progress === 100 && info.status !== 'downloaded') {
                for (let i = 0; i < 10 && info.status !== 'downloaded'; i++) {
                    await new Promise(r => setTimeout(r, 1000));
                    info = await rdTorrentInfo(debridApiKey, torrentId);
                }
            }

            if (info.progress === 100 && info.status === 'downloaded' && info.links?.length > 0) {
                const targetLink = info.links[0];
                const unrestricted = await rdUnrestrictLink(debridApiKey, targetLink);
                if (unrestricted && unrestricted.download) {
                    // Uložíme do cache
                    if (!rdCacheLoaded) nacitatRdCache();
                    rdCache[hash.toLowerCase()] = { cached_at: Date.now() };
                    ulozitRdCache();
                    logSuccess(`[RD DOWNLOAD] Hash ${hash.substring(0,12)} uložený do cache + redirect`);
                    return res.redirect(302, unrestricted.download);
                }
            }

            logApi(`[RD DOWNLOAD] Torrent nie je cached (${info?.status}), info-video`);
        }

        res.redirect(302, '/info-video');
    } catch (err) {
        logError("Debrid API download/upload error", err);
        res.status(500).send("Chyba API sťahovania debrid služby.");
    }
}));


app.get("/logo.jpg", (req, res) => {
    res.sendFile(path.join(__dirname, "logo.jpg"));
});

app.get("/logo.png", (req, res) => {
    res.sendFile(path.join(__dirname, "logo.png"));
});

app.get("/ko-fi-logo.jpg", (req, res) => {
    res.sendFile(path.join(__dirname, "ko-fi-logo.jpg"));
});

app.get("/info-video", (req, res) => {
    res.sendFile(path.join(__dirname, "stahuje-sa.mp4")); 
});

// Error middleware — Express 4 default vráti HTML stacktrace; tu vrátime čistú JSON/plain odpoveď
// (bez leaknutia interných detailov) a zalogujeme chybu.
app.use((err, req, res, next) => {
    logError(`Unhandled error na ${req.method} ${maskConfigVUrl(req.originalUrl)}`, err);
    if (res.headersSent) return next(err);
    if (req.path.includes("/stream/")) {
        return res.status(500).json({ streams: [] });
    }
    res.status(500).send("Chyba servera.");
});

// Export pre Genezio a Vercel (@vercel/node)
exports.handler = app;
module.exports = app;

// fallback pre lokálne spustenie
app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 TorrentSK beží na portu ${PORT}`);
    console.log(`🌐 Public URL: ${PUBLIC_URL}`);
    console.log(`======================================================\n`);
});


