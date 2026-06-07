// SKTorrent Addon v1.7.0 + TORBOX + ČSFD
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
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`; 
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

// ÚPLNE ZMENENÁ FUNKCIA (bez použitia withCache z tvojej Map)
async function overitTorboxCache(infoHashes, torboxKey) {
    if (!torboxKey || !infoHashes || infoHashes.length === 0) return {};
    
    // TOTO JE TA OPRAVA: Najprv vyfiltruje vsetko co nie je undefined/null a az potom robi toLowerCase
    const platneHashe = infoHashes.filter(h => h && typeof h === 'string');
    if (platneHashe.length === 0) return {};

    const unikatneHashe = [...new Set(platneHashe)].map(h => h.toLowerCase());
    const hashString = unikatneHashe.sort().join(",");
    
    logApi(`Checking TorBox cache directly for ${unikatneHashe.length} hashes`);
    try {
        const res = await axios.get(`https://api.torbox.app/v1/api/torrents/checkcached`, {
            params: { hash: hashString, format: "list" },
            headers: { "Authorization": `Bearer ${torboxKey}` },
            timeout: 5000
        });
        
        const cacheMap = {};
        if (res.data && res.data.success && res.data.data) {
            const poleDat = Array.isArray(res.data.data) ? res.data.data : [res.data.data];
            poleDat.forEach(item => { 
                if (item && item.hash) cacheMap[item.hash.toLowerCase()] = true; 
            });
        }
        logSuccess(`TorBox cache check complete. Found ${Object.keys(cacheMap).length} cached items.`);
        return cacheMap;
    } catch (error) {
        logError("TorBox cache check failed", error);
        return {};
    }
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
    const kvalitaText = kvality.length > 0 ? `🎥 ${kvality.join(" • ")}` : "🎥 Kvalita neznáma";

    const fileSize = najdenyIndex !== -1 ? 
        (torrentData.files.find(f => f.index === najdenyIndex)?.length || 0) : 
        torrentData.files.reduce((acc, f) => acc + (f.length || 0), 0);
    const formatFileSize = formatBytes(fileSize);
    const velkostText = `💿 ${formatFileSize} (🧩 ${t.size})`;

    const langMatch = cistyNazov.match(/\b(CZ|SK|EN)\b/ig) || [];
    const vlajkyList = langMatch.map(kod => langToFlag[kod.toUpperCase()]).filter(Boolean);
    const unikatneVlajky = [...new Set(vlajkyList)];
    let jazykText = "Neznámy jazyk";
    if (unikatneVlajky.length > 0) {
        jazykText = unikatneVlajky.join(" / ");
    } else if (langMatch.length > 0) {
        const textoveJazyky = [...new Set(langMatch.map(l => l.toUpperCase()))];
        jazykText = textoveJazyky.join(" / ");
    }

    // Získanie počtu seedov (t.seeds je dostupné z tvojho vyhľadávacieho scrapera)
    const seedersText = t.seeds !== undefined ? `👥 Seeders: ${t.seeds}` : "👥 N/A";

    // Vytvorenie lepšie usporiadaného zoznamu
    const riadkyTitle = [];

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
    riadkyTitle.push(`🔊 ${jazykText}   |   ${kvalitaText}`);

    // Riadok 4: Technické info (Veľkosť a počet Seedov)
    riadkyTitle.push(`${velkostText}   |   ${seedersText}`);

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
    cistyNazovSuboru = cistyNazovSuboru.replace(/[^a-zA-Z0-9.\-]/g, '_');

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
        fileIdx: najdenyIndex === -1 ? 0 : najdenyIndex
    };

    return streamObj;
}
// ===================================================================
// VLASTNÝ EXPRESS SERVER BEZ `getRouter` Z SDK
// ===================================================================
const app = express();
app.use(cors()); 

app.use((req, res, next) => {
    console.log(`\n======================================================`);
    console.log(`[${getTime()}] 🌍 [HTTP REQUEST] -> ${req.method} ${req.originalUrl}`);
    console.log(`[${getTime()}] 📡 IP: ${req.ip} | User-Agent: ${req.headers['user-agent']?.substring(0, 50)}...`);
    next(); 
});

// --- Web UI ---
app.get(['/', '/configure', '/:config/configure'], (req, res) => {
    
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

    const getQualityVal = (index, defaultVal) => {
        if (currentConfig.qualityOrder && currentConfig.qualityOrder[index] !== undefined) {
            return currentConfig.qualityOrder[index];
        }
        return defaultVal;
    };

    const q1 = getQualityVal(0, 4);
    const q2 = getQualityVal(1, 3);
    const q3 = getQualityVal(2, 2);
    const q4 = getQualityVal(3, 1);

    const html = `
    <!DOCTYPE html>
    <html lang="sk">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>SKTorrent Multi-User Addon</title>
        <style>
            body { font-family: Arial, sans-serif; background: #111; color: white; display: flex; justify-content: center; padding-top: 50px; }
            .container { background: #222; padding: 30px; border-radius: 8px; width: 100%; max-width: 450px; box-shadow: 0 4px 10px rgba(0,0,0,0.5); }
            h2 { text-align: center; color: #8A5A9E; margin-bottom: 5px; }
            label { display: block; margin-top: 15px; font-size: 14px; font-weight: bold; }
            input, select { width: 100%; padding: 10px; margin-top: 5px; background: #333; border: 1px solid #444; color: white; border-radius: 4px; box-sizing: border-box;}
            .inline-selects { display: flex; justify-content: space-between; gap: 10px; margin-top: 5px;}
            .inline-selects select { width: 22%; text-align: center; }
            button { width: 100%; padding: 12px; margin-top: 25px; background: #8A5A9E; color: white; border: none; font-size: 16px; border-radius: 4px; cursor: pointer; font-weight: bold; }
            button:hover { background: #6b467a; }
            
            #result-box { display: none; margin-top: 20px; padding: 15px; background: #1a1a1a; border: 1px solid #8A5A9E; border-radius: 4px; text-align: center; }
            #generated-url { width: 100%; font-size: 12px; padding: 8px; margin: 10px 0; background: #000; color: #0f0; border: 1px solid #333; word-break: break-all; box-sizing: border-box; resize: none; overflow: hidden; height: 60px; }
            .copy-btn { background: #444; margin-top: 5px; }
            .copy-btn:hover { background: #555; }
            .install-btn { background: #28a745; margin-top: 10px; }
            .install-btn:hover { background: #218838; }
            
            .checkbox-label { display: flex; align-items: center; font-weight: normal; margin-top: 15px; }
            .checkbox-label input { width: auto; margin-right: 10px; margin-top: 0;}
        </style>
    </head>
    <body>
        <div class="container">
            <h2>SKTorrent Addon</h2>
            <p style="text-align:center; font-size:13px; color:#aaa;">Vyplň svoje údaje na vygenerovanie inštalačného odkazu.</p>
            
            <label>SKTorrent UID (Cookie s názvom uid)</label>
            <input type="text" id="uid" placeholder="Napr. 123987" value="${getVal('uid')}" required>
            
            <label>SKTorrent pass (Tiež z cookies s názvom pass)</label>
            <input type="password" id="pass" placeholder="Tvoj pass" value="${getVal('pass')}" required>
            
            <label>TorBox API Key (Odporúčané)</label>
            <input type="text" id="torbox" placeholder="TorBox token" value="${getVal('torbox')}">
            
            <label>TMDB API Key (Voliteľné)</label>
            <input type="text" id="tmdb" placeholder="TMDB token" value="${getVal('tmdb')}">

            <label>TVDB API Key (Voliteľné — vyhľadáva SK/CZ názvy)</label>
            <input type="text" id="tvdb" placeholder="TVDB token" value="${getVal('tvdb')}">
            
            <hr style="border: 1px solid #444; margin-top: 20px;">
            <h3 style="text-align: center; color: #aaa; margin-bottom: 5px;">Nastavenia zobrazenia</h3>

            <label class="checkbox-label">
                <input type="checkbox" id="showUncached" ${getCheck('showUncached', true)}> Zobraziť nenastiahnuté (Uncached ⏳)
            </label>

            <label>Zoradenie podľa veľkosti:</label>
            <select id="sizeOrder">
                <option value="desc" ${getSelect('sizeOrder', 'desc', 'desc')}>Najväčšie prvé (Odporúčané)</option>
                <option value="asc" ${getSelect('sizeOrder', 'asc', 'desc')}>Najmenšie prvé</option>
            </select>

            <label>Priorita kvality (1. až 4.):</label>
            <div class="inline-selects">
                <select class="q-order"><option value="4" ${q1 === 4 ? 'selected':''}>4K</option><option value="3" ${q1 === 3 ? 'selected':''}>1080p</option><option value="2" ${q1 === 2 ? 'selected':''}>720p</option><option value="1" ${q1 === 1 ? 'selected':''}>SD</option></select>
                <select class="q-order"><option value="4" ${q2 === 4 ? 'selected':''}>4K</option><option value="3" ${q2 === 3 ? 'selected':''}>1080p</option><option value="2" ${q2 === 2 ? 'selected':''}>720p</option><option value="1" ${q2 === 1 ? 'selected':''}>SD</option></select>
                <select class="q-order"><option value="4" ${q3 === 4 ? 'selected':''}>4K</option><option value="3" ${q3 === 3 ? 'selected':''}>1080p</option><option value="2" ${q3 === 2 ? 'selected':''}>720p</option><option value="1" ${q3 === 1 ? 'selected':''}>SD</option></select>
                <select class="q-order"><option value="4" ${q4 === 4 ? 'selected':''}>4K</option><option value="3" ${q4 === 3 ? 'selected':''}>1080p</option><option value="2" ${q4 === 2 ? 'selected':''}>720p</option><option value="1" ${q4 === 1 ? 'selected':''}>SD</option></select>
            </div>

            <button onclick="generateLink()">Vygenerovať odkaz</button>

            <div id="result-box">
                <p style="margin:0; font-size:14px; font-weight:bold; color:#8A5A9E;">Tvoj inštalačný odkaz:</p>
                <textarea id="generated-url" readonly></textarea>
                
                <button class="copy-btn" onclick="copyUrl()">📋 Kopírovať do schránky</button>
                <button class="install-btn" onclick="openStremio()">🚀 Nainštalovať do Stremia</button>
            </div>
        </div>

        <script>
            function generateLink() {
                var qSelects = document.querySelectorAll('.q-order');
                var qArray = [];
                for(var i = 0; i < qSelects.length; i++) {
                    qArray.push(parseInt(qSelects[i].value));
                }
                qArray.push(0); 

                var uniqueQArray = [];
                for(var j = 0; j < qArray.length; j++) {
                    if(uniqueQArray.indexOf(qArray[j]) === -1) {
                        uniqueQArray.push(qArray[j]);
                    }
                }

                var config = {
                    uid: document.getElementById('uid').value,
                    pass: document.getElementById('pass').value,
                    torbox: document.getElementById('torbox').value,
                    tmdb: document.getElementById('tmdb').value,
                    tvdb: document.getElementById('tvdb').value,
                    showUncached: document.getElementById('showUncached').checked,
                    sizeOrder: document.getElementById('sizeOrder').value,
                    qualityOrder: uniqueQArray,
                    cb: Date.now()
                };

                if(!config.uid || !config.pass) {
                    alert('Prosím, vyplň aspoň UID a Heslo pre SKTorrent.'); 
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
                } catch (error) {
                    alert('Chyba pri generovaní kódu.');
                    console.error(error);
                }
            }

            function copyUrl() {
                var urlText = document.getElementById('generated-url');
                urlText.select();
                document.execCommand('copy');
                var copyBtn = document.querySelector('.copy-btn');
                copyBtn.innerText = "✅ Skopírované!";
                setTimeout(function() { copyBtn.innerText = "📋 Kopírovať do schránky"; }, 2000);
            }

            function openStremio() {
                var httpUrl = document.getElementById('generated-url').value;
                var stremioUrl = httpUrl.replace("https://", "stremio://").replace("http://", "stremio://");
                window.location.assign(stremioUrl);
            }
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
        id: "org.stremio.skcztorrent.addon", 
        version: "1.7.0",
        name: "SKTorrent + TorBox (Multi-User)",
        description: "SKTorrent s TorBox prehrávaním, ČSFD a metadátami",
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

    if (!activeUid || !activePass) {
        logWarn(`Stream request denied - Invalid or missing config.`);
        return res.json({ streams: [], error: "Neplatná konfigurácia." });
    }
    
    const normalizedConfig = { uid: activeUid, pass: activePass, torbox: activeTorbox, tmdb: activeTmdb, tvdb: userConfig.tvdb };
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

        if (userConfig.torbox && streamy.length > 0) {
        logInfo("TorBox enabled. Preparing streams for TorBox playback...");
        const hasheKONTROLA = streamy.map(s => s.infoHash).filter(Boolean); 
        const torboxCache = await overitTorboxCache(hasheKONTROLA, userConfig.torbox);

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
        
        streamy = streamy.map(stream => {
            const hash = stream.infoHash.toLowerCase();
            const jeCached = torboxCache[hash] === true;
            const staraKategoria = stream.name.split("\n")[1] || "";
            const proxySeria = seria || 0;
            const proxyEpizoda = epizoda || 0;
            
            const sortText = `${staraKategoria} ${stream.title || ""}`;
            
            let finalStream = {
                name: jeCached ? `[TB ⚡] SKT\n${staraKategoria}` : `[TB ⏳] SKT\n${staraKategoria}`,
                title: stream.title,
                type: vlastnyTyp,
                behaviorHints: stream.behaviorHints,

                _sortCached: jeCached ? 1 : 0,
                _sortQuality: getQualityRank(sortText),
                _sortSize: getSizeBytes(sortText)
            };

            if (jeCached) {
                const safeName = (stream.fileName || "video.mkv").split('/').join('|');
                finalStream.url = `${PUBLIC_URL}/${config}/play/${hash}/${proxySeria}/${proxyEpizoda}/${encodeURIComponent(safeName)}`;
            } else {
                finalStream.url = `${PUBLIC_URL}/${config}/download/${hash}/${stream.sktId}`;
            }
            return finalStream;
        });

        const showUncached = userConfig.showUncached !== undefined ? userConfig.showUncached : true;
        if (!showUncached) {
            streamy = streamy.filter(s => s._sortCached === 1);
        }

        const sizeOrder = userConfig.sizeOrder || "desc"; 
        const defaultQualityOrder = [4, 3, 2, 1, 0];
        const qualityOrder = userConfig.qualityOrder || defaultQualityOrder;

        streamy = streamy.sort((a, b) => {
            if (b._sortCached !== a._sortCached) {
                return b._sortCached - a._sortCached;
            }

            const indexA = qualityOrder.indexOf(a._sortQuality);
            const indexB = qualityOrder.indexOf(b._sortQuality);
            
            const rankA = indexA === -1 ? 99 : indexA;
            const rankB = indexB === -1 ? 99 : indexB;

            if (rankA !== rankB) {
                return rankA - rankB;
            }

            if (sizeOrder === "asc") {
                return a._sortSize - b._sortSize;
            } else {
                return b._sortSize - a._sortSize;
            }
        });

        streamy = streamy.map(({ _sortCached, _sortQuality, _sortSize, ...rest }) => rest);

        logSuccess(`TorBox stream formatting complete. Cached: ${streamy.filter(s => s.name.includes("⚡")).length}, Uncached: ${streamy.filter(s => s.name.includes("⏳")).length}`);

        const trvanie = Date.now() - startCas;
        logSuccess(`Stream request finished in ${trvanie}ms. Returning ${streamy.length} streams to Stremio.`);

        const maUncachedStreamy = streamy.some(s => s.name && s.name.includes("⏳"));
        const cacheMaxAge = maUncachedStreamy ? 60 : 3600;
        res.setHeader('Cache-Control', `max-age=${cacheMaxAge}, stale-while-revalidate=${cacheMaxAge}, stale-if-error=${cacheMaxAge}`);
        // ---------------------------------

        return res.json({ streams: streamy });


    } 
});


// =========================================================================
// TORBOX PROXY ROUTER
// =========================================================================
app.get('/:config/play/:hash/:seria/:epizoda/:fileName', async (req, res) => {
    const { hash, seria, epizoda, config } = req.params;
    const decodedFileName = decodeURIComponent(req.params.fileName || "").replace(/\|/g, "/");
    logApi(`TorBox Play Request: Hash: ${hash} | S${seria}E${epizoda} | File: ${decodedFileName}`);

    const userConfig = decodeConfig(config);
    if (!userConfig || !userConfig.torbox) {
        return res.status(400).send("Chýba TorBox kľúč.");
    }
    const TORBOX_API_KEY = userConfig.torbox;

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
    res.status(404).send("Torbox nevrátil URL.");
}
} catch (err) {
    logError("TorBox play proxy error", err);
    res.status(500).send("Chyba proxy servera.");
}
});


app.get("/:config/download/:hash/:sktId", async (req, res) => {
    const { hash, sktId, config } = req.params;
    
    const userConfig = decodeConfig(config);
    if (!userConfig || !userConfig.uid || !userConfig.pass) return res.status(400).send("Chyba Configu");
    if (!userConfig.torbox) return res.status(400).send("Chyba Torbox Key");

    const TORBOX_API_KEY = userConfig.torbox;
    const userAxios = getFastAxios(userConfig);

    try {
        const torrentUrl = `${BASE_URL}/torrent/download.php?id=${sktId}`;
        const torrentBuffer = await stiahnutSurovyTorrent(torrentUrl, userAxios);

        if (!torrentBuffer) return res.status(500).send("Nepodarilo sa stiahnuť .torrent súbor.");

        const formData = new FormData();
        formData.append("file", torrentBuffer, { filename: `${hash}.torrent`, contentType: "application/x-bittorrent" });

        await axios.post("https://api.torbox.app/v1/api/torrents/createtorrent", formData, {
            headers: { "Authorization": `Bearer ${TORBOX_API_KEY}`, ...formData.getHeaders() },
            timeout: 15000
        });


        res.redirect(302, `/info-video`);
    } catch (err) {
        logError("TorBox API download/upload error", err);
        res.status(500).send("Chyba API stahovania TorBox.");
    }
});

app.get("/info-video", (req, res) => {
    res.sendFile(path.join(__dirname, "stahuje-sa.mp4")); 
});

app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 SKTorrent Multi-User beží na portu ${PORT}`);
    console.log(`🌐 Public URL: ${PUBLIC_URL}`);
    console.log(`======================================================\n`);
});


