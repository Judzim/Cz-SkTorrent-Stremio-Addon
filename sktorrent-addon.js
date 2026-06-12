// SKTorrent Addon v2.0.0 + TORBOX + ČSFD
const { addonBuilder } = require("stremio-addon-sdk");
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
// const { csfd } = require('node-csfd-api'); 

const PORT = process.env.PORT || 7000; 
// const PUBLIC_URL = "https://bda31382-bef9-4743-b2e2-e9838ecb6690.eu-central-1.cloud.genez.io"; 
const PUBLIC_URL = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`); 
const BASE_URL = "https://sktorrent.eu"; 
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;
const TVDB_API_KEY = "d786995d-7841-4640-a4a5-8d30592d1651";

const agentOptions = { keepAlive: true, maxSockets: 50 };

// ===================================================================
// LOGOVACÍ SYSTÉM
// ===================================================================
function getTime() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function logInfo(msg) { console.log(`[${getTime()}] ℹ️ INFO: ${msg}`); }
function logSuccess(msg) { console.log(`[${getTime()}] ✅ SUCCESS: ${msg}`); }
function logWarn(msg) { console.warn(`[${getTime()}] ⚠️ WARN: ${msg}`); }
function logError(msg, err = "") { console.error(`[${getTime()}] ❌ ERROR: ${msg}`, err ? err.message || err : ""); }
function logCache(msg) { console.log(`[${getTime()}] 📦 CACHE: ${msg}`); }
function logApi(msg) { console.log(`[${getTime()}] 🌐 API: ${msg}`); }

// ===================================================================
// CACHE a CONCURRENCY SYSTÉM
// ===================================================================
const cache = new Map(); // Nechame tu len aby to nehodilo error ak sa na to nieco iné odkazuje

async function withCache(key, ttlMs, fetcher) {
    logCache(`BYPASS CACHE - Ziskavam data nazivo pre: ${key}`);
    try {
        // Zavoláme priamo funkciu na ziskanie dat, do pamate nic neukladame
        const data = await fetcher();
        return data;
    } catch (error) {
        logError(`Failed to fetch key (no cache): ${key}`, error);
        return null;
    }
}


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

function getFastAxios(userConfig) {
    const { uid, pass } = userConfig;
    return axios.create({
        timeout: 5000, 
        httpAgent: new http.Agent(agentOptions),
        httpsAgent: new https.Agent(agentOptions),
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
    
    // 1. Skontrolujeme shared cache (checkcached) – rýchle, existujúca logika
    logApi(`Checking TorBox cache directly for ${unikatneHashe.length} hashes`);
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

    // 2. Skontrolujeme aj mylist – user môže mať torrent stiahnutý v osobnom účte,
    //    aj keď nie je v shared cache (napr. vzácny/privátny torrent)
    try {
        const mylistRes = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
            headers: { Authorization: `Bearer ${torboxKey}` },
            timeout: 5000,
            params: { bypass_cache: true }
        });

        if (mylistRes.data?.success && Array.isArray(mylistRes.data.data)) {
            for (const item of mylistRes.data.data) {
                if (!item.hash) continue;
                const h = item.hash.toLowerCase();
                // Ak hash hľadáme a torrent je už stiahnutý → označíme ako cached
                if (unikatneHashe.includes(h) && (item.cached || item.download_finished)) {
                    if (!cacheMap[h]) {
                        cacheMap[h] = true;
                        logCache(`Torrent najdeny v mylist (download_finished): ${h.substring(0,12)}...`);
                    }
                }
            }
        }
    } catch (error) {
        logWarn(`TorBox mylist check failed (volitelne): ${error.message}`);
    }

    logSuccess(`TorBox cache check complete. Found ${Object.keys(cacheMap).length} cached items (checkcached + mylist).`);
    return cacheMap;
}

// ===================================================================
// REAL-DEBRID FUNKCIE (cez StremThru proxy)
// ===================================================================
const STREMTHRU_URL = "https://stremthru.13377001.xyz";

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

async function overitRealDebridCache(infoHashes, rdKey) {
    if (!rdKey || !infoHashes || infoHashes.length === 0) return {};
    
    const platneHashe = infoHashes.filter(h => h && typeof h === 'string');
    if (platneHashe.length === 0) return {};

    const unikatneHashe = [...new Set(platneHashe)].map(h => h.toLowerCase());
    const cacheMap = {};

    logApi(`RD cache check cez StremThru (${unikatneHashe.length} hashov)`);

    // Jeden batch request — StremThru overí cache pre všetky hashe naraz
    try {
        const magnetParam = unikatneHashe.map(h => `magnet:?xt=urn:btih:${h}`).join(',');
        const url = `${STREMTHRU_URL}/v0/store/magnets/check?magnet=${encodeURIComponent(magnetParam)}&client_ip=127.0.0.1&sid=stremio`;

        const response = await axios.get(url, {
            headers: {
                "X-StremThru-Store-Name": "realdebrid",
                "X-StremThru-Store-Authorization": `Bearer ${rdKey}`,
                "User-Agent": "TorrentSK/1.0"
            },
            timeout: 30000
        });

        const data = response.data;
        if (!data || !data.data || !Array.isArray(data.data.items)) {
            logWarn(`StremThru vrátil neočakávaný formát`);
            return {};
        }

        for (const item of data.data.items) {
            const hash = item.hash ? item.hash.toLowerCase() : null;
            if (!hash) continue;
            
            if (!unikatneHashe.includes(hash)) continue;

            if (item.status === 'cached') {
                logSuccess(`RD CACHED cez StremThru: ${hash.substring(0,12)}... (${item.name || '?'})`);
                cacheMap[hash] = true;
            } else {
                logCache(`RD NOT cached: ${hash.substring(0,12)}... (status: ${item.status})`);
            }
        }

        logSuccess(`StremThru cache check complete. Found ${Object.keys(cacheMap).length}/${unikatneHashe.length} cached items.`);
    } catch (error) {
        if (error.response) {
            logError(`StremThru API error (HTTP ${error.response.status})`, JSON.stringify(error.response.data).substring(0, 300));
        } else {
            logError(`StremThru error: ${error.message || 'unknown'}`);
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
    
    for (const lang of ["slk", "ces", "eng"]) {
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
    }
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
        if (vlastnyTyp === "series" && tmdbId && tvdbKey) {
            try {
                const extRes = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}/external_ids`, { params: { api_key: tmdbKey }, timeout: 4000 });
                const tvdbId = extRes.data?.tvdb_id;
                if (tvdbId) {
                    logApi(`TVDB fallback pre TMDB ID ${tmdbId} → TVDB ID ${tvdbId}`);
                    await pridajTvdbNazvy(nazvy, tvdbId, tvdbKey);
                }
            } catch (e) { logWarn(`TVDB fallback failed pre TMDB ${tmdbId}`); }
        }

        if (!titleOriginal) titleOriginal = titleCz; 

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
async function hladatTorrenty(dotaz, userAxios, maxPages = 1) {
    if (!dotaz || dotaz.trim().length < 2) return [];
    
    // Ak hľadáme cez exaktný ČSFD link, chceme načítať viac stránok 
    // (napr. až 4), pretože seriály môžu mať desiatky epizód zoradených od najnovších.
    const skutocneMaxPages = dotaz.includes("csfd.cz") ? 20 : maxPages;
    
    return withCache(`search_paged_${skutocneMaxPages}:${dotaz}`, 600000, async () => {
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

                    if (!kategoria.toLowerCase().includes("film") && !kategoria.toLowerCase().includes("seri") &&
                        !kategoria.toLowerCase().includes("dokum") && !kategoria.toLowerCase().includes("tv")) return;

                    videnieIds.add(torrentId);
                    vsetkyVysledky.push({
                        name: nazov, id: torrentId,
                        size: velkostMatch ? velkostMatch[1].trim() : "?",
                        seeds: seedMatch ? parseInt(seedMatch[1]) : 0,
                        category: kategoria,
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
                logError(`SKTorrent search failed on page ${page} for: "${dotaz}"`, chyba);
                break;
            }
        }
        
        return vsetkyVysledky.sort((a, b) => b.seeds - a.seeds); 
    });
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

            logSuccess(`Successfully parsed .torrent (Hash: ${infoHash}) from ${url}`);
            return { infoHash, files: subory };
        } catch (chyba) {
            logError(`Failed to download/parse .torrent from ${url}`, chyba);
            return null;
        }
    });
}

async function stiahnutSurovyTorrent(url, userAxios) {
    return withCache(`rawtorrent:${url}`, 86400000, async () => {
        try {
            const res = await userAxios.get(url, { responseType: "arraybuffer" });
            const bufferString = res.data.toString("utf8", 0, 50);
            if (bufferString.includes("<html") || bufferString.includes("<!DOC")) return null;
            return res.data; 
        } catch (chyba) {
            return null;
        }
    });
}

async function vytvoritStream(t, seria, epizoda, userAxios, meta, userConfig) {
    logInfo(`Creating stream for torrent ID: ${t.id} (${t.name})`);
    const torrentData = await stiahnutTorrentData(t.downloadUrl, userAxios);
    if (!torrentData) return null;
    
    let najdenyIndex = -1;
    let najdenyNazovSuboru = null;

    // --- OČISTENIE NÁZVU (Hneď na začiatku, aby ho videl streamObj) ---
    let cistyNazov = t.name.replace(/^Stiahni si\s*/i, "").trim();
    if (cistyNazov.toLowerCase().startsWith(t.category.trim().toLowerCase())) {
        cistyNazov = cistyNazov.slice(t.category.length).trim();
    }

    // --- VYHĽADANIE KONKRÉTNEJ EPIZÓDY ---
    if (seria !== undefined && epizoda !== undefined) {
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
     } else {
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
    if (/\b(?:cam|tsrip|tele(?:sync|cine))\b/i.test(cistyNazov)) sourceTypes.push('cam');
    const sourceTag = sourceTypes.length > 0 ? sourceTypes.join(',') : 'neznámy';
    const kvalitaText = kvality.length > 0 ? `🎥 ${kvality.join(" • ")}` : "🎥 Kvalita neznáma";

    const hdrFeatures = [];
    if (analyzaNazvu.includes('hdr10')) hdrFeatures.push('hdr10');
    else if (analyzaNazvu.includes('hdr')) hdrFeatures.push('hdr');
    if (analyzaNazvu.includes('dovi') || analyzaNazvu.includes('vision')) hdrFeatures.push('dv');
    if (analyzaNazvu.includes('hevc') || analyzaNazvu.includes('h265') || analyzaNazvu.includes('x265')) hdrFeatures.push('hevc');
    if (analyzaNazvu.includes('atmos')) hdrFeatures.push('atmos');
    const hdrTag = hdrFeatures.length > 0 ? hdrFeatures.join(',') : '';
    const fileSize = najdenyIndex !== -1 ? 
        (torrentData.files.find(f => f.index === najdenyIndex)?.length || 0) : 
        torrentData.files.reduce((acc, f) => acc + (f.length || 0), 0);
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

    // --- FINÁLNE TVORENIE OBJEKTU
    let streamObj = {
        name: `SKT\n${t.category.toUpperCase()}`,
        title: riadkyTitle.join("\n"),
        behaviorHints: { 
            bingeGroup: `sktorrent-${kvality.length > 0 ? kvality.join("-").replace(/\s/g, "") : "standard"}`
        },
        sktId: t.id,
        fileName: cistyNazovSuboru,
        infoHash: torrentData.infoHash,
        fileIdx: najdenyIndex === -1 ? 0 : najdenyIndex,
        isDub: jeSKCZ,
        seeds: t.seeds,
        _sortHdr: hdrTag,
        _sortSource: sourceTag,
        _sortRdBlocked: jeRdBlokovany ? 1 : 0,
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

app.use((req, res, next) => {
    console.log(`\n======================================================`);
    console.log(`[${getTime()}] 🌍 [HTTP REQUEST] -> ${req.method} ${req.originalUrl}`);
    console.log(`[${getTime()}] 📡 IP: ${req.ip} | User-Agent: ${req.headers['user-agent']?.substring(0, 50)}...`);
    next(); 
});

// --- Web UI ---
// --- API: SKTorrent Login Proxy ---
app.post('/api/sktorrent-login', async (req, res) => {
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
});
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
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d0d0d; color: #e0e0e0; display: flex; justify-content: center; padding: 30px 15px; }
            .container { background: #1a1a2e; padding: 0; border-radius: 12px; width: 100%; max-width: 500px; box-shadow: 0 8px 32px rgba(0,0,0,0.6); overflow: hidden; }
            .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 24px; text-align: center; border-bottom: 1px solid #2a2a4a; }
            .header h2 { font-size: 22px; font-weight: 700; background: linear-gradient(135deg, #8A5A9E, #e040a0); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
            .header p { font-size: 13px; color: #888; margin-top: 6px; }

            .section { border-bottom: 1px solid #2a2a4a; }
            .section:last-child { border-bottom: none; }
            .section-header { display: flex; align-items: center; gap: 10px; padding: 16px 20px 8px; font-size: 13px; font-weight: 600; color: #8A5A9E; text-transform: uppercase; letter-spacing: 0.5px; }
            .section-header .icon { font-size: 18px; }
            .section-desc { padding: 0 20px 12px; font-size: 12px; color: #666; }

            .field { padding: 8px 20px; }
            .field label { display: block; font-size: 12px; font-weight: 600; color: #aaa; margin-bottom: 4px; }
            .field input, .field select { width: 100%; padding: 10px 12px; background: #0d0d1a; border: 1px solid #2a2a4a; color: #e0e0e0; border-radius: 8px; font-size: 14px; outline: none; transition: border 0.2s; }
            .field input:focus, .field select:focus { border-color: #8A5A9E; }
            .field select { cursor: pointer; appearance: auto; }

            .checkbox-row { display: flex; align-items: center; gap: 10px; padding: 6px 20px; cursor: pointer; }
            .checkbox-row:hover { background: rgba(138,90,158,0.05); }
            .checkbox-row input[type="checkbox"] { width: 18px; height: 18px; accent-color: #8A5A9E; cursor: pointer; }
            .checkbox-row .label-text { font-size: 14px; color: #ccc; }
            .checkbox-row .label-desc { font-size: 11px; color: #666; margin-left: auto; }

            .chip-group { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 20px; }
            .chip { display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; background: #0d0d1a; border: 1px solid #2a2a4a; border-radius: 20px; font-size: 13px; color: #ccc; cursor: pointer; transition: all 0.2s; user-select: none; }
            .chip:hover { border-color: #8A5A9E; }
            .chip.active { background: #8A5A9E6; border-color: #8A5A9E; color: #fff; background: rgba(138,90,158,0.25); }

            .sort-row { display: flex; align-items: center; gap: 8px; padding: 6px 20px; }
            .sort-row .num { width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; background: #0d0d1a; border: 1px solid #2a2a4a; border-radius: 50%; font-size: 11px; color: #666; flex-shrink: 0; }
            .sort-row select { flex: 1; padding: 8px 10px; background: #0d0d1a; border: 1px solid #2a2a4a; color: #e0e0e0; border-radius: 8px; font-size: 13px; outline: none; cursor: pointer; }
            .sort-row select:focus { border-color: #8A5A9E; }
            .sort-btn { width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; background: #0d0d1a; border: 1px solid #2a2a4a; border-radius: 6px; color: #666; cursor: pointer; font-size: 14px; flex-shrink: 0; transition: all 0.2s; }
            .sort-btn:hover { border-color: #8A5A9E; color: #8A5A9E; }
            .sort-btn:disabled { opacity: 0.3; cursor: not-allowed; }
            .sort-toggle { width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #8A5A9E; cursor: pointer; font-size: 16px; flex-shrink: 0; padding: 0; transition: opacity 0.2s; }
            .sort-toggle:hover { opacity: 0.7; }

            .btn-primary { width: calc(100% - 40px); margin: 16px 20px; padding: 12px; background: linear-gradient(135deg, #8A5A9E, #e040a0); color: white; border: none; font-size: 15px; font-weight: 600; border-radius: 8px; cursor: pointer; transition: all 0.2s; }
            .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 4px 15px rgba(138,90,158,0.4); }

            #result-box { display: none; margin: 0 20px 20px; padding: 20px; background: rgba(138,90,158,0.08); border: 1px solid #8A5A9E; border-radius: 10px; text-align: center; }
            #result-box p { font-size: 12px; color: #8A5A9E; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
            #generated-url { width: 100%; font-size: 12px; font-family: 'Courier New', monospace; padding: 10px; margin-bottom: 14px; background: #0d0d1a; color: #e0e0e0; border: 1px solid #2a2a4a; border-radius: 8px; word-break: break-all; resize: none; height: 52px; outline: none; transition: border 0.2s; }
            #generated-url:focus { border-color: #8A5A9E; }
            .btn-sm { padding: 8px 16px; border: 1px solid #2a2a4a; border-radius: 8px; font-size: 13px; cursor: pointer; margin: 3px; transition: all 0.2s; }
            .btn-copy { background: #0d0d1a; color: #ccc; }
            .btn-copy:hover { background: rgba(138,90,158,0.25); border-color: #8A5A9E; color: #fff; }
            .btn-install { background: linear-gradient(135deg, #8A5A9E, #e040a0); color: white; border: none; }
            .btn-install:hover { transform: translateY(-1px); box-shadow: 0 4px 15px rgba(138,90,158,0.4); }
            .lang-btn { background:none; border:1px solid #2a2a4a; border-radius:6px; padding:4px 10px; font-size:13px; color:#ccc; cursor:pointer; transition:all 0.2s; }
            .lang-btn:hover { border-color: #8A5A9E; }
            .lang-btn.active { border-color: #8A5A9E; background: rgba(138,90,158,0.2); color:#fff; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <div style="display:flex;align-items:center;justify-content:space-between;">
                    <div style="flex:1;text-align:left;">
                        <button class="lang-btn active" data-lang-btn="sk" onclick="setLang('sk')">🇸🇰</button>
                        <button class="lang-btn" data-lang-btn="en" onclick="setLang('en')">🇬🇧</button>
                    </div>
                    <div style="flex:2;">
                        <h2 data-i18n="title">TorrentSK</h2>
                        <p data-i18n="subtitle" style="font-size:13px;color:#888;margin-top:6px;">Nastav si preferencie a vygeneruj inštalačný odkaz</p>
                    </div>
                </div>
            </div>

            <!-- 🔌 Connection -->
            <div class="section">
                <div class="section-header"><span class="icon">🔌</span> <span data-i18n="section.connection">Connection</span></div>
                <div class="section-desc" data-i18n="desc.connection">Prihlasovacie údaje a API kľúče</div>
                
                <!-- Login cez SKTorrent -->
                <div class="field" id="loginFields">
                    <label>🔑 <span data-i18n="label.sktorrentLogin">Prihlásiť sa na SKTorrent</span></label>
                    <div style="display:flex;gap:8px;flex-wrap:wrap;">
                        <input type="text" id="loginUser" data-i18n-placeholder="login.uid.placeholder" placeholder="Používateľské meno" style="flex:1;min-width:120px;">
                        <input type="password" id="loginPass" data-i18n-placeholder="login.pass.placeholder" placeholder="Heslo" style="flex:1;min-width:120px;">
                        <button id="loginBtn" onclick="loginToSKTorrent()" style="padding:8px 16px;background:linear-gradient(135deg,#8A5A9E,#e040a0);color:white;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;" data-i18n="button.login">Prihlásiť sa</button>
                    </div>
                    <div id="loginStatus" style="font-size:12px;margin-top:6px;"></div>
                </div>
                
                <!-- Hidden uid/pass fields (vyplnia sa automaticky po prihlásení) -->
                <div id="hiddenCredentials" style="display:none;">
                    <input type="hidden" id="uid" value="">
                    <input type="hidden" id="pass" value="">
                </div>
                
                <!-- Manual fallback - ak niekto chce rucne zadat uid/pass -->
                <div style="padding:0 20px 8px;">
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
                <div class="field" id="debridServiceField">
                    <label data-i18n="label.debrid">Debrid služba</label>
                    <select id="debridProvider" onchange="toggleDebridFields()">
                        <option value="" ${getSelect('debridProvider','','') || (!currentConfig.debridProvider && !currentConfig.torbox ? 'selected' : '')} data-i18n="debrid.p2p">P2P (žiadny debrid)</option>
                        <option value="torbox" ${getSelect('debridProvider','torbox','') || (currentConfig.torbox && !currentConfig.debridProvider ? 'selected' : '')}>TorBox</option>
                        <option value="realdebrid" ${getSelect('debridProvider','realdebrid','')}>Real-Debrid</option>
                    </select>
                </div>
                <div class="field" id="torboxField" style="display:${currentConfig.debridProvider === 'torbox' || (!currentConfig.debridProvider && currentConfig.torbox) ? '' : 'none'};">
                    <label data-i18n="label.torbox">TorBox API kľúč</label>
                    <input type="text" id="torbox" data-i18n-placeholder="torbox.placeholder" placeholder="TorBox token" value="${getVal('torbox')}">
                    <div style="font-size:11px;color:#666;margin-top:2px;"><a href="https://torbox.app/settings?section=account" target="_blank" rel="noopener" style="color:#8A5A9E;text-decoration:none;" data-i18n-link="torbox.help">🔗 torbox.app/settings?section=account</a></div>
                </div>
                <div class="field" id="realdebridField" style="display:${currentConfig.debridProvider === 'realdebrid' ? '' : 'none'};">
                    <label data-i18n="label.realdebrid">Real-Debrid API kľúč</label>
                    <input type="text" id="realdebrid" data-i18n-placeholder="realdebrid.placeholder" placeholder="Real-Debrid API token" value="${getVal('realdebrid')}">
                    <div style="font-size:11px;color:#666;margin-top:2px;"><a href="https://real-debrid.com/devices" target="_blank" rel="noopener" style="color:#8A5A9E;text-decoration:none;" data-i18n-link="realdebrid.help">🔗 real-debrid.com/devices</a></div>
                </div>
                <div class="field">
                    <label><span data-i18n="label.tmdb">TMDB API kľúč</span> <span style="color:#666;font-weight:400;" data-i18n-optional="label.tmdb.optional">(voliteľné)</span></label>
                    <input type="text" id="tmdb" data-i18n-placeholder="tmdb.placeholder" placeholder="TMDB token" value="${getVal('tmdb')}">
                    <div style="font-size:11px;color:#666;margin-top:2px;"><a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener" style="color:#8A5A9E;text-decoration:none;" data-i18n-link="tmdb.help">🔗 themoviedb.org/settings/api</a></div>
                </div>
                <div class="field" style="padding-bottom:16px;">
                    <label><span data-i18n="label.tvdb">TVDB API kľúč</span> <span style="color:#666;font-weight:400;" data-i18n-optional="label.tvdb.optional">(voliteľné)</span></label>
                    <input type="text" id="tvdb" data-i18n-placeholder="tvdb.placeholder" placeholder="TVDB token" value="${getVal('tvdb')}">
                    <div style="font-size:11px;color:#666;margin-top:2px;"><a href="https://thetvdb.com/dashboard/account/apikey" target="_blank" rel="noopener" style="color:#8A5A9E;text-decoration:none;" data-i18n-link="tvdb.help">🔗 thetvdb.com/dashboard/account/apikey</a></div>
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

                <div class="checkbox-row" onclick="toggleCheckbox('cachedOnly', event)">
                    <input type="checkbox" id="cachedOnly" ${getCheck('cachedOnly', false)}>
                    <span class="label-text" data-i18n="checkbox.cached">Cached Only</span>
                    <span class="label-desc" data-i18n="checkbox.cached.desc">Len TorBox cachované streamy</span>
                </div>
                <div style="padding: 8px 20px 4px;"><label style="font-size:12px;font-weight:600;color:#aaa;" data-i18n="label.videoQuality">Kvalita videa</label></div>
                <div class="chip-group" id="hdrChips" style="padding-bottom:12px;">
                    <span class="chip active" data-hdr="hdr" onclick="toggleChip(this)">HDR</span>
                    <span class="chip active" data-hdr="dv" onclick="toggleChip(this)">Dolby Vision</span>
                    <span class="chip active" data-hdr="hevc" onclick="toggleChip(this)">HEVC</span>
                    <span class="chip active" data-hdr="atmos" onclick="toggleChip(this)">Atmos</span>
                </div>

                <div style="padding: 8px 20px 4px;"><label style="font-size:12px;font-weight:600;color:#aaa;" data-i18n="label.filter18">18+ filter</label></div>
                <div class="chip-group" id="adultChips" style="padding-bottom:4px;">
                    <span class="chip active" data-adult="hide" onclick="toggleChip(this)"><span data-i18n="chip.hide18">Skryť 18+ obsah</span></span>
                </div>

                <div style="padding: 8px 20px 4px;"><label style="font-size:12px;font-weight:600;color:#aaa;" data-i18n="label.sourceType">🎞️ Typ zdroja</label></div>
                <div class="chip-group" id="sourceChips" style="padding-bottom:12px;">
                    <span class="chip active" data-source="webdl" onclick="toggleChip(this)">WEB-DL</span>
                    <span class="chip active" data-source="bluray" onclick="toggleChip(this)">BluRay</span>
                    <span class="chip active" data-source="hdtv" onclick="toggleChip(this)">HDTV</span>
                    <span class="chip active" data-source="dvdrip" onclick="toggleChip(this)">DVDRip</span>
                    <span class="chip active" data-source="webrip" onclick="toggleChip(this)">WEBRip</span>
                    <span class="chip active" data-source="hdrip" onclick="toggleChip(this)">HDRip</span>
                    <span class="chip active" data-source="ppv" onclick="toggleChip(this)">PPV</span>
                    <span class="chip active" data-source="remux" onclick="toggleChip(this)">Remux</span>
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
            var SORT_OPTIONS = ['cached', 'quality', 'lang', 'seeds', 'size'];
            var SORT_LABELS = { cached: 'Cached', quality: 'Rozlíšenie', lang: 'Jazyk', seeds: 'Seedy', size: 'Veľkosť' };
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
                    'debrid.p2p': 'P2P (žiadny debrid)',
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
                    'checkbox.cached.desc': 'Len TorBox cachované streamy',
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
                    'desc.sort': 'Priorita radenia výsledkov',
                    'button.generate': '✨ Vygenerovať odkaz',
                    'result.title': 'Tvoj inštalačný odkaz',
                    'button.copy': '📋 Kopírovať',
                    'button.install': '🚀 Inštalovať',
                    'alert.fillUidPass': 'Prosím, vyplň aspoň UID a pass pre SKTorrent.',
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
                    'debrid.p2p': 'P2P (no debrid)',
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
                    'checkbox.cached.desc': 'TorBox cached streams only',
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
                    'section.sort': 'Sort Order',
                    'desc.sort': 'Result sorting priority',
                    'button.generate': '✨ Generate link',
                    'result.title': 'Your install link',
                    'button.copy': '📋 Copy',
                    'button.install': '🚀 Install',
                    'alert.fillUidPass': 'Please fill in at least UID and pass for SKTorrent.',
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
                // Update SORT_LABELS
                SORT_LABELS = { cached: t('sort.cached'), quality: t('sort.quality'), lang: t('sort.lang'), seeds: t('sort.seeds'), size: t('sort.size') };
                // Re-render sort rows with new labels
                var sortContainer = document.getElementById('sortOrders');
                if (sortContainer) {
                    var vals = [];
                    var activeMask = [];
                    var rows = sortContainer.querySelectorAll('.sort-row');
                    for (var si = 0; si < rows.length; si++) {
                        var sel = rows[si].querySelector('.sort-select');
                        if (sel) vals.push(sel.value);
                        activeMask.push(rows[si].dataset.active !== 'false');
                    }
                    if (vals.length) initSortRows(vals, activeMask);
                }
                // Update lang switcher active state
                document.querySelectorAll('.lang-btn').forEach(function(btn) {
                    var lb = btn.getAttribute('data-lang-btn');
                    btn.classList.toggle('active', lb === CURR_LANG);
                });
            }

            function getSortValues() {
                var rows = document.querySelectorAll('.sort-row');
                var vals = [];
                for (var i = 0; i < rows.length; i++) {
                    if (rows[i].dataset.active !== 'false') {
                        var sel = rows[i].querySelector('.sort-select');
                        vals.push(sel.value);
                    }
                }
                return vals;
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

                    var sel = document.createElement('select');
                    sel.className = 'sort-select';
                    for (var j = 0; j < SORT_OPTIONS.length; j++) {
                        var opt = document.createElement('option');
                        opt.value = SORT_OPTIONS[j];
                        opt.textContent = SORT_LABELS[SORT_OPTIONS[j]];
                        if (SORT_OPTIONS[j] === used[i]) opt.selected = true;
                        sel.appendChild(opt);
                    }
                    row.appendChild(sel);

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
                    var s = rows[si].querySelector('.sort-select');
                    vals.push(s.value);
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
                var config = {
                    uid: uidVal,
                    pass: passVal,
                    debridProvider: document.getElementById('debridProvider').value,
                    torbox: document.getElementById('torbox').value,
                    realdebrid: document.getElementById('realdebrid').value,
                    tmdb: document.getElementById('tmdb').value,
                    tvdb: document.getElementById('tvdb').value,
                    lang: getActiveChips('#langChips .chip'),
                    show: getActiveChips('#showChips .chip'),
                    cachedOnly: document.getElementById('cachedOnly').checked,
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

                if(!config.uid || !config.pass) {
                    alert(t('alert.fillUidPass'));
                    return;
                }

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
                if (torboxField) torboxField.style.display = (provider === 'torbox') ? '' : 'none';
                if (realdebridField) realdebridField.style.display = (provider === 'realdebrid') ? '' : 'none';
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

// --- Manifest Route ---
const handleManifest = (req, res) => {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Surrogate-Control': 'no-store'
    });

    res.json({
        id: "org.stremio.sktorrent.addon", 
        version: "2.0.0",
        name: "TorrentSK",
        description: "SKTorrent s TorBox prehrávaním, ČSFD a metadátami",
        logo: `${PUBLIC_URL}/logo.png`,
        icon: `${PUBLIC_URL}/logo.png`,
        types: ["movie", "series"],
        catalogs: [],
        resources: ["stream"],
        idPrefixes: ["tt"],
        behaviorHints: {
            configurable: true,
            configurationRequired: false
        }
    });
};

app.get('/manifest.json', handleManifest);
app.get('/:config/manifest.json', handleManifest);

app.get('/:config?/catalog/:type/:id.json', (req, res) => {
    res.json({ metas: [] });
});

// --- Stream Route ---
app.get('/:config/stream/:type/:id.json', async (req, res) => {
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
        logWarn(`Stream request denied - Invalid or missing config.`);
        return res.json({ streams: [], error: "Neplatná konfigurácia." });
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
    console.log(`\n====== 🎬 Hľadám pre UID: ${normalizedConfig.uid} | id='${id}' ======`);

    const jeToSerialPodlaId = id.includes(":");
    const [imdbId, sRaw, eRaw] = id.split(":");
    const seria = (jeToSerialPodlaId && sRaw) ? parseInt(sRaw) : undefined;
    const epizoda = (jeToSerialPodlaId && eRaw) ? parseInt(eRaw) : undefined;
    const vlastnyTyp = jeToSerialPodlaId ? "series" : "movie";

    // 1. ZÍSKAME NÁZVY A ROK a META
    const metaData = await ziskatVsetkyNazvyARok(imdbId, vlastnyTyp, userConfig.tmdb, userConfig.tvdb);
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

    const dotazy = new Set();

    // 2. ČSFD LINK
    // Snažíme sa použiť primárne český názov z metadát pre ČSFD vyhľadávanie
        const hlavnyNazov = metaData?.meta?.titleOriginal || unikatneNazvy[0];
        const csfdLink = await ziskatCsfdUrl(imdbId, hlavnyNazov, vydanyRok, vlastnyTyp);
    
    if (csfdLink) {
        dotazy.add(csfdLink); 
    }

    // 3. Fallback na klasické textové hľadanie
    unikatneNazvy.forEach(zaklad => {
        const bezDia = odstranDiakritiku(zaklad);
        const kratky = skratNazov(bezDia, 3); 

        if (vlastnyTyp === "series" && seria !== undefined && epizoda !== undefined) {
            const epTag  = ` S${String(seria).padStart(2, "0")}E${String(epizoda).padStart(2, "0")}`; 
            const epTag2 = ` ${seria}x${String(epizoda).padStart(2, "0")}`; 
            const sTag1  = ` S${String(seria).padStart(2, "0")}`; 
            const sTag2  = ` ${seria}.série`; 
            const sTag3  = ` ${seria}. série`; 

            dotazy.add(bezDia + epTag);
            dotazy.add(zaklad + epTag);
            dotazy.add(bezDia + sTag3); 
            dotazy.add(kratky + sTag3); 
            dotazy.add(bezDia + sTag2); 
            dotazy.add(kratky + sTag2); 
            dotazy.add(bezDia + sTag1); 
            dotazy.add(kratky + sTag1); 
            dotazy.add(bezDia + epTag2);
            dotazy.add(kratky + epTag2);
            dotazy.add(bezDia);
            dotazy.add(kratky);
        } else {
            [zaklad, bezDia, kratky].forEach(b => {
                if (!b.trim()) return;
                dotazy.add(b);
            });
        }
    });

    let torrenty = [];
    let pokus = 1;
    const videnieTorrentIds = new Set();
    let uspesneNajdeneCezCsfd = false;

    for (const d of dotazy) { 
        logInfo(`Search attempt ${pokus}: "${d}"`);
        const najdene = await hladatTorrenty(d, userAxios);
        
        let pocetNovych = 0;
        for (const t of najdene) {
            if (!videnieTorrentIds.has(t.id)) {
                torrenty.push(t);
                videnieTorrentIds.add(t.id);
                pocetNovych++;
            }
        }
        
        if (d === csfdLink && torrenty.length > 0) {
            logSuccess(`Nájdené cez ČSFD Link. Mám ${torrenty.length} výsledkov.`);
            uspesneNajdeneCezCsfd = true;
        }
        
        // Upravené: Ukončíme textové dotazy iba vtedy, ak sme nazbierali naozaj veľa (napr 30+)
        // alebo ak sme použili presný ČSFD link (ten vráti vďaka paginácii kľudne 60 torrentov naraz)
        if (uspesneNajdeneCezCsfd || torrenty.length >= 30) {
            logInfo("Dostatok torrentov nájdených alebo použitý presný link, preskakujem ďalšie dotazy.");
            break; 
        }

        if (pokus > 10) break; 
        pokus++;
    }

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
                if (new RegExp(`^${escaped}\\b`, "i").test(rawName)) return true;
            }
            return false;
        });
        logInfo(`Title accuracy filter complete. Remaining: ${torrenty.length} (filtered out ${predNameFiltrom - torrenty.length} unrelated titles)`);
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
                    _sortQuality: getQualityRank(sortText),
                    _sortSize: getSizeBytes(sortText),
                    _sortSeeds: stream.seeds || 0
                };

                const safeName = (stream.fileName || "video.mkv").split('/').join('|');
                if (jeCached) {
                    // Cached (akýkoľvek debrid): cez /play – okamžité prehratie
                    finalStream.url = `${PUBLIC_URL}/${config}/play/${hash}/${proxySeria}/${proxyEpizoda}/${encodeURIComponent(safeName)}`;
                } else {
                    // Necachovaný: cez /download – pridá do debridu, potom info video alebo rovno stream
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
                return {
                    name: `SKT\n${staraKategoria}`,
                    title: stream.title,
                    infoHash: stream.infoHash,
                    fileIdx: stream.fileIdx,
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
                    _sortSeeds: stream.seeds || 0
                };
            });
        }

        // ── Ak nie sú žiadne streamy ──
        if (streamy.length === 0) {
            logInfo("No streams found. Returning empty list.");
            return res.json({ streams: [] });
        }

        // ── FILTROVANIE (Meteor-štýl) ──

        // 1. Cached Only filter
        const cachedOnly = userConfig.cachedOnly === true;
        if (cachedOnly) {
            streamy = streamy.filter(s => s._sortCached === 1);
        }

        // 2. Resolution filter (chips: 2160p, 1080p, 720p, sd)
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
                if (!hdr) return false;
                return userHdr.some(function(h) { return hdr.includes(h); });
            });
        }

        // 2c. 18+ filter (chips: hide)
        const userAdult = userConfig.adult;
        if (userAdult && Array.isArray(userAdult) && userAdult.includes('hide')) {
            streamy = streamy.filter(s => {
                const name = (s._sortName || '').toLowerCase();
                const cat = (s._sortCategory || '').toLowerCase();
                const adultKeywords = ['erotick','porn','xxx','adult','18+','sex','onlyfans'];
                if (cat.includes('erotick')) return false;
                for (let ki = 0; ki < adultKeywords.length; ki++) {
                    if (name.includes(adultKeywords[ki])) return false;
                }
                return true;
            });
        }

        // 2d. Source type filter (chips: webdl, bluray, hdtv, dvdrip, webrip, hdrip, ppv, remux, cam)
        const userSource = userConfig.source;
        if (userSource && Array.isArray(userSource) && userSource.length > 0 && userSource.length < 8) {
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
                            if (s._sortRdBlocked === 1) return -1; // blocked → najnižšia priorita
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
        const maxPerResVal = parseInt(userConfig.maxPerRes || '0');
        if (maxPerResVal > 0) {
            const grouped = {};
            for (let i = 0; i < streamy.length; i++) {
                const s = streamy[i];
                const q = s._sortQuality || 0;
                if (!grouped[q]) grouped[q] = [];
                if (grouped[q].length < maxPerResVal) {
                    grouped[q].push(s);
                }
            }
            streamy = [];
            const qualityOrder = [4, 3, 2, 1, 0];
            for (let qi = 0; qi < qualityOrder.length; qi++) {
                const items = grouped[qualityOrder[qi]];
                if (items) streamy = streamy.concat(items);
            }
        }

        // Odstrániť interné _sort polia
        streamy = streamy.map(({ _sortCached, _sortRdBlocked, _sortDub, _sortDubLang, _sortName, _sortCategory, _sortHdr, _sortSource, _sortQuality, _sortSize, _sortSeeds, ...rest }) => rest);

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
    });


// =========================================================================
// TORBOX PROXY ROUTER
// =========================================================================
app.get('/:config/play/:hash/:seria/:epizoda/:fileName', async (req, res) => {
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

    if (debridProvider === 'torbox') {
        return handleTorboxPlay(req, res, hash, seria, epizoda, decodedFileName, userConfig, debridApiKey);
    } else if (debridProvider === 'realdebrid') {
        return handleRealDebridPlay(req, res, hash, decodedFileName, debridApiKey);
    }

    return res.status(400).send("Neznámy debrid provider.");
});

async function handleTorboxPlay(req, res, hash, seria, epizoda, decodedFileName, userConfig, TORBOX_API_KEY) {
    logApi(`TorBox Play Request: Hash: ${hash} | S${seria}E${epizoda} | File: ${decodedFileName}`);
    try {
        const tbTorrentsRes = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
            headers: { Authorization: `Bearer ${TORBOX_API_KEY}` }
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
                headers: { Authorization: `Bearer ${TORBOX_API_KEY}`, ...formData.getHeaders() }
            });

            torrentId = addRes.data?.data?.torrent_id;

            await new Promise(r => setTimeout(r, 3000));
            const tbRefreshRes = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
                headers: { Authorization: `Bearer ${TORBOX_API_KEY}` }
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
            headers: { Authorization: `Bearer ${TORBOX_API_KEY}` }
        });

const directLink = downloadRes.data?.data;
if (directLink) {
    logSuccess(`[TORBOX PROXY] Redirectujem na TorBox CDN URL`);
    res.redirect(302, directLink);
} else {
    // Torrent je v TorBoxe ale ešte nie je pripravený na streamovanie
    logApi(`[TORBOX PROXY] Torrent sa ešte sťahuje, requestdl nevrátil URL`);
    res.status(202).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sťahovanie prebieha</title><style>body{font-family:sans-serif;background:#1a1a2e;color:#e0e0e0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;text-align:center}div{max-width:500px;padding:2rem}h1{color:#ffd700;margin-bottom:1rem}p{line-height:1.6;color:#aaa}a{color:#ffd700}</style></head><body><div><h1>⏳ Sťahovanie prebieha</h1><p>Torrent bol pridaný do TorBoxu a práve sa sťahuje.<br>Počkaj kým sa stiahne a potom skús prehrať znova.</p><p style="font-size:0.9em;color:#666;margin-top:2rem">Ak sa video nespustí ani po dokončení, skús obnoviť zoznam streamov.</p></div></body></html>`);
}
} catch (err) {
    logError("TorBox play proxy error", err);
    res.status(500).send("Chyba proxy servera.");
}
}

function getStremThruHeaders(apiKey) {
    return {
        "X-StremThru-Store-Name": "realdebrid",
        "X-StremThru-Store-Authorization": `Bearer ${apiKey}`,
        "User-Agent": "TorrentSK/1.0",
        "Content-Type": "application/json"
    };
}

async function handleRealDebridPlay(req, res, hash, decodedFileName, RD_API_KEY) {
    logApi(`[RD PLAY] StremThru proxy pre hash: ${hash}`);
    try {
        // 1. Pridáme magnet cez StremThru (POST /v0/store/torz)
        // StremThru zistí či je cachovaný a vráti files[].link (stremthru:// URL)
        const magnetUri = `magnet:?xt=urn:btih:${hash}`;
        const addRes = await axios.post(`${STREMTHRU_URL}/v0/store/torz`,
            { link: magnetUri },
            {
                headers: getStremThruHeaders(RD_API_KEY),
                timeout: 30000
            }
        );

        const torzData = addRes.data?.data;
        if (!torzData || !torzData.files) {
            return res.status(500).send("StremThru nevrátil platné dáta.");
        }

        if (torzData.status === 'downloaded') {
            // Nájdeme správny video súbor
            const fileName = decodedFileName.split('/').pop() || '';
            let targetFile = torzData.files.find(f =>
                (f.name || f.path || '').includes(fileName) || fileName.includes((f.name || f.path || '').split('/').pop())
            );
            if (!targetFile) {
                targetFile = torzData.files.find(f => /\.(mp4|mkv|avi|m4v|mov)$/i.test(f.name || f.path || ''));
            }
            if (!targetFile) targetFile = torzData.files[0];

            if (targetFile?.link) {
                // 2. Vygenerujeme priamy CDN link cez StremThru (valid 12h)
                const genRes = await axios.post(`${STREMTHRU_URL}/v0/store/torz/link/generate`,
                    { link: targetFile.link },
                    {
                        headers: getStremThruHeaders(RD_API_KEY),
                        timeout: 15000
                    }
                );

                const directUrl = genRes.data?.data?.link;
                if (directUrl) {
                    logSuccess(`[RD PLAY] StremThru redirect OK`);
                    return res.redirect(302, directUrl);
                }
            }
        }

        // Nie je priamo hrateľné – skúsime najprv nájsť existujúci torrent v StremThru
        // (môže byť už stiahnutý z predchádzajúceho kliku)
        logApi(`[RD PLAY] Status: ${torzData.status}. Skúšam nájsť existujúci torrent...`);
        
        try {
            const listRes = await axios.get(`${STREMTHRU_URL}/v0/store/torz`, {
                headers: getStremThruHeaders(RD_API_KEY),
                timeout: 10000,
                params: { hash, limit: 1 }
            });
            
            const existingItems = listRes.data?.data?.items || listRes.data?.data || [];
            const existingTorz = Array.isArray(existingItems) 
                ? existingItems.find(t => t.hash?.toLowerCase() === hash.toLowerCase() && t.status === 'downloaded')
                : null;
            
            if (existingTorz?.files?.[0]?.link) {
                logSuccess(`[RD PLAY] Nájdený existujúci stiahnutý torrent`);
                const genRes = await axios.post(`${STREMTHRU_URL}/v0/store/torz/link/generate`,
                    { link: existingTorz.files[0].link },
                    { headers: getStremThruHeaders(RD_API_KEY), timeout: 15000 }
                );
                const directUrl = genRes.data?.data?.link;
                if (directUrl) return res.redirect(302, directUrl);
            }
        } catch (listErr) {
            logWarn(`[RD PLAY] Chyba pri hľadaní existujúceho torrentu: ${listErr.message}`);
        }
        
        logApi(`[RD PLAY] Torrent sa ešte sťahuje`);
        return res.status(202).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sťahovanie prebieha</title><style>body{font-family:sans-serif;background:#1a1a2e;color:#e0e0e0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;text-align:center}div{max-width:500px;padding:2rem}h1{color:#ffd700;margin-bottom:1rem}p{line-height:1.6;color:#aaa}a{color:#ffd700}</style></head><body><div><h1>⏳ Sťahovanie prebieha</h1><p>Torrent bol pridaný do Real-Debrid a práve sa sťahuje.<br>Počkaj kým sa stiahne a potom skús prehrať znova.</p></div></body></html>`);

    } catch (err) {
        const status = err.response?.status;
        const errCode = err.response?.data?.code === 'UNAVAILABLE_FOR_LEGAL_REASONS';
        
        if (status === 451 || status === 503 || errCode) {
            const dekNazov = decodeURIComponent(decodedFileName || '').split('/').pop() || 'neznámy';
            logError(`[RD PLAY] StremThru blokuje súbor: ${dekNazov}`);
            return res.status(500).send(`Real-Debrid blokuje tento súbor (infringing_file). Skús iný zdroj.`);
        }
        
        logError(`[RD PLAY] StremThru chyba`, err);
        if (err.response) {
            logError(`[RD PLAY] HTTP ${status} - ${JSON.stringify(err.response.data).substring(0,200)}`);
        }
        return res.status(500).send(`Chyba Real-Debrid: ${err.message}`);
    }
}

// ========================================================================="

app.get("/:config/download/:hash/:sktId", async (req, res) => {
    const { hash, sktId, config } = req.params;
    
    const userConfig = decodeConfig(config);
    if (!userConfig || !userConfig.uid || !userConfig.pass) return res.status(400).send("Chyba Configu");

    const debridProvider = userConfig.debridProvider || (userConfig.torbox ? 'torbox' : '');
    const debridApiKey = debridProvider === 'torbox' ? userConfig.torbox : (debridProvider === 'realdebrid' ? userConfig.realdebrid : null);

    if (!debridApiKey) return res.status(400).send("Chýba debrid API kľúč.");

    const userAxios = getFastAxios(userConfig);

    try {
        const torrentUrl = `${BASE_URL}/torrent/download.php?id=${sktId}`;
        const torrentBuffer = await stiahnutSurovyTorrent(torrentUrl, userAxios);
        if (!torrentBuffer) return res.status(500).send("Nepodarilo sa stiahnuť .torrent súbor.");

        if (debridProvider === 'torbox') {
            const formData = new FormData();
            formData.append("seed_instantly", "true");
            formData.append("allow_zip", "false");
            formData.append("seed", "2");
            formData.append("file", torrentBuffer, { filename: `${hash}.torrent`, contentType: "application/x-bittorrent" });

            const createRes = await axios.post("https://api.torbox.app/v1/api/torrents/createtorrent", formData, {
                headers: { "Authorization": `Bearer ${debridApiKey}`, ...formData.getHeaders() },
                timeout: 15000
            });

            // Skúsime získať torrentId a rovno requestdl
            // (torrent už môže byť v shared cache, alebo DUPLICATE_ITEM vracia existujúci ID)
            const tbData = createRes.data?.data;
            let torrentId = tbData?.torrent_id ?? tbData?.id ?? tbData?.queued_id ?? null;

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
                    logApi(`[TB DOWNLOAD] Torrent nahratý, čaká na stiahnutie (requestdl zatiaľ nič nevráti)`);
                } catch (dlErr) {
                    logApi(`[TB DOWNLOAD] requestdl zlyhal, torrent sa ešte sťahuje: ${dlErr.message}`);
                }
            }
        } else if (debridProvider === 'realdebrid') {
            // Pridáme magnet cez StremThru (POST /v0/store/torz)
            const magnetUri = `magnet:?xt=urn:btih:${hash}`;
            try {
                const addRes = await axios.post(`${STREMTHRU_URL}/v0/store/torz`,
                    { link: magnetUri },
                    {
                        headers: getStremThruHeaders(debridApiKey),
                        timeout: 30000
                    }
                );

                const torzData = addRes.data?.data;
                if (torzData && torzData.id) {
                    logApi(`[RD DOWNLOAD] StremThru pridalo torrent: ${torzData.id} (status: ${torzData.status})`);
                    
                    // Ak je rovno stiahnutý, vygenerujeme CDN link a streamujeme
                    if (torzData.status === 'downloaded' && torzData.files?.[0]?.link) {
                        const genRes = await axios.post(`${STREMTHRU_URL}/v0/store/torz/link/generate`,
                            { link: torzData.files[0].link },
                            { headers: getStremThruHeaders(debridApiKey), timeout: 15000 }
                        );
                        const directUrl = genRes.data?.data?.link;
                        if (directUrl) {
                            logSuccess(`[RD DOWNLOAD] Torrent je rovno hrateľný, redirectujem na stream`);
                            return res.redirect(302, directUrl);
                        }
                    }
                } else {
                    logWarn(`[RD DOWNLOAD] StremThru nevrátilo ID: ${JSON.stringify(addRes.data).substring(0,100)}`);
                }
            } catch (addErr) {
                if (addErr.response?.status === 451 || addErr.response?.data?.code === 'UNAVAILABLE_FOR_LEGAL_REASONS') {
                    logWarn(`[RD DOWNLOAD] StremThru blokuje súbor (infringing_file)`);
                } else {
                    logWarn(`[RD DOWNLOAD] StremThru error: ${addErr.message}`);
                }
            }
        }

        res.redirect(302, `/info-video`);
    } catch (err) {
        logError("Debrid API download/upload error", err);
        res.status(500).send("Chyba API sťahovania debrid služby.");
    }
});

app.get("/logo.jpg", (req, res) => {
    res.sendFile(path.join(__dirname, "logo.jpg"));
});

app.get("/logo.png", (req, res) => {
    res.sendFile(path.join(__dirname, "logo.png"));
});

app.get("/info-video", (req, res) => {
    res.sendFile(path.join(__dirname, "stahuje-sa.mp4")); 
});

// Export pre Genezio (httpServer typ)
exports.handler = app;

// fallback pre lokálne spustenie
app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 TorrentSK beží na portu ${PORT}`);
    console.log(`🌐 Public URL: ${PUBLIC_URL}`);
    console.log(`======================================================\n`);
});


