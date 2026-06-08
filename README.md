# 🎬 SKTorrent Stremio Addon

Neoficiálny Stremio doplnok pre vyhľadávanie a streamovanie filmov a seriálov z populárneho slovenského trackera **SKTorrent.eu**. Addon funguje na princípe vlastnej konfigurácie – každý používateľ si zadáva svoje vlastné prihlasovacie údaje (cookies) z SKTorrentu.

## 🚀 Inštalácia (Verejné inštancie)

Addon si môžeš nainštalovať a nakonfigurovať na tejto verejne bežiacej inštancii:

🔗 **[Beamup Inštancia](https://52e4d3c860ff-sktorrent-addon.baby-beamup.club/configure)**

---

## ⭐ Hlavné funkcie a vlastnosti

*   ⚡ **Podpora Debrid služieb (TorBox / Real-Debrid)**: Addon podporuje TorBox aj Real-Debrid. Po vložení API kľúča automaticky overí, či je torrent už cachovaný na serveroch danej služby. Cachované streamy sa prehrávajú okamžite, necachované sa automaticky stiahnu. Výber providera (P2P / TorBox / Real-Debrid) sa robí v konfigurácii.
*   🔍 **Vyhľadávanie cez ČSFD a viacero názvov**: Addon automaticky scrapuje ČSFD pre získanie presného českého/slovenského názvu filmu alebo seriálu. Ak nájde ČSFD odkaz, prehľadáva SKTorrent až do 20 stránok výsledkov pre istotu nájdenia aj starších epizód. Doplnkovo sťahuje názvy z TMDB (originálne aj preložené do CS/SK/EN) a TVDB, čím maximalizuje šancu na zhodu.
*   🧠 **Pokročilý Regex pre SK/CZ seriály**: Rozpoznáva obrovské množstvo našských formátov seriálov (napr. `S01E01`, `1x01`, `1. - 4. serie`, `1. Epizoda`, `105.Epizóda`, `Pack`, `Komplet`). Automaticky extrahuje správny video súbor aj z veľkých gigabajtových packov.
*   🎥 **Detailné informácie o streame**: Priamo v Stremio vidíš krásne naformátované dáta:
    *   **Kvalita & Formát:** 4K, 1080p, HDR, Dolby Vision, HEVC, H.264, Atmos...
    *   **Jazyk (Vlajky):** 🇸🇰 🇨🇿 🇬🇧 🇺🇸 na základe analýzy názvu.
    *   **Veľkosť:** Skutočná veľkosť daného video súboru + veľkosť celého torrentu.

---

## ⚙️ Ako získať údaje pre konfiguráciu

### UID a PASS (SKTorrent, povinné)

Aby addon fungoval, potrebuješ mať účet na SKTorrent.eu. Addon pre svoju funkčnosť vyžaduje hodnoty z tvojich **Cookies** (`uid` a `pass`).

**Postup pre Chrome/Edge/Firefox:**
1. Otvor si stránku [sktorrent.eu](https://sktorrent.eu) a prihlás sa.
2. Stlač klávesu `F12` (otvoria sa Vývojárske nástroje / Developer Tools).
3. Choď do záložky **Application** (Aplikácia) / **Storage** (Uložisko) -> vľavo v menu rozbaľ **Cookies** a klikni na `https://sktorrent.eu`.
4. V tabuľke nájdi riadok s názvom `uid` a skopíruj si jeho hodnotu (napr. `123456`).
5. Nájdi riadok s názvom `pass` a skopíruj si jeho hodnotu (dlhý alfanumerický reťazec).
6. Tieto dva údaje vlož do konfiguračného okna na jednej z webových inštancií vyššie a vygeneruj si inštalačný odkaz.

### Real-Debrid API kľúč (voliteľné)

1. Prihlás sa na [real-debrid.com](https://real-debrid.com/).
2. Choď do nastavení: **Account → API Token** alebo priamo na [real-debrid.com/devices](https://real-debrid.com/devices).
3. Skopíruj svoj API token a vlož ho do poľa "Real-Debrid API kľúč" v konfigurácii.

### TorBox API kľúč (voliteľné)

1. Prihlás sa na [torbox.app](https://torbox.app/).
2. Choď do nastavení: **Settings → Account → API Key** alebo priamo na [torbox.app/settings?section=account](https://torbox.app/settings?section=account).
3. Skopíruj svoj API kľúč a vlož ho do poľa "TorBox API kľúč" v konfigurácii.

---

## 📊 Význam prefixov a správanie Debrid režimu

Pri zapnutom debrid providerovi (TorBox / Real-Debrid) majú streamy v Stremiu prefix podľa stavu:

| Prefix | Význam |
|---|---|
| `[⚡]` | **Cachovaný** — torrent je na serveroch a streamuje sa okamžite |
| `[⏳]` | **Necachovaný** — torrent sa práve sťahuje na servery; prehratie sa spustí po dokončení |
| `[❌]` | **Blokovaný** (iba Real-Debrid) — Real-Debrid blokuje názvy obsahujúce určité reťazce (napr. `BDRip`, `WEB-DL`, `RARBG`, `YTS`). Tieto streamy sa nedajú prehrať cez RD a sú automaticky presunuté na koniec radenia |

Každý používateľ má vlastný API kľúč, ale cache status (⚡/⏳) je globálny — ak jeden človek stiahne torrent na RD servery, nabudúce ho uvidia všetci ako cachovaný.

---

## 👨‍💻 Pre vývojárov (Lokálne spustenie)

Ak si chceš addon spustiť lokálne alebo upravovať kód:

```bash
# Naklonovanie repozitára
git clone https://github.com/Judzim/Cz-SkTorrent-Stremio-Addon.git
cd Cz-SkTorrent-Stremio-Addon

# Inštalácia závislostí
npm install

# Spustenie servera
PUBLIC_URL=http://localhost:7000 npm start

Server štandardne pobeží na porte 7000. Konfiguračnú stránku nájdeš na http://localhost:7000/.
```
⚠️ Upozornenie: Tento addon slúži len na technické, vzdelávacie a vyhľadávacie účely. Addon neobsahuje žiadne mediálne súbory, len spracováva a formátuje metadáta dostupné na internete na základe požiadavky používateľa.
