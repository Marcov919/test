"""
Decision Maker Scraper
======================
Trova i decision maker (C-suite, VP, Director) delle 100 aziende piu' fighe.

Strategia multi-fonte:
  1. Leadership page aziendale  (es. /about, /team, /leadership)
  2. Google Search pubblica     (es. "Stripe CEO site:linkedin.com")
  3. Crunchbase public          (pagina /people di ogni org)

Output: lista di dict con nome, titolo, azienda, fonte, url profilo.
"""

import re
import time
import logging
import random
from dataclasses import dataclass, field, asdict
from typing import Optional
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from tenacity import retry, stop_after_attempt, wait_exponential
from fake_useragent import UserAgent

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configurazione
# ---------------------------------------------------------------------------

LEADERSHIP_PATHS = [
    "/about", "/about-us", "/team", "/our-team", "/leadership",
    "/company/team", "/company/leadership", "/management",
    "/about/leadership", "/about/team", "/founders",
]

EXECUTIVE_TITLES = [
    "CEO", "Chief Executive", "CTO", "Chief Technology",
    "CFO", "Chief Financial", "COO", "Chief Operating",
    "CPO", "Chief Product", "CMO", "Chief Marketing",
    "CRO", "Chief Revenue", "CISO", "Chief Information Security",
    "President", "Co-Founder", "Founder", "Managing Director",
    "VP of Engineering", "VP Engineering", "VP of Product",
    "VP of Sales", "VP of Marketing", "VP of Operations",
    "Head of", "General Manager", "Director",
]

REQUEST_TIMEOUT = 12
DELAY_BETWEEN_REQUESTS = (1.5, 3.5)  # secondi random


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class DecisionMaker:
    name: str
    title: str
    company: str
    domain: str
    sector: str
    linkedin_url: str = ""
    email: str = ""
    source_url: str = ""
    source: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

class SmartSession:
    """Session con user-agent rotation e retry automatico."""

    def __init__(self):
        try:
            self._ua = UserAgent()
        except Exception:
            self._ua = None
        self._session = requests.Session()

    def _headers(self) -> dict:
        ua = (
            self._ua.random if self._ua
            else "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                 "AppleWebKit/537.36 (KHTML, like Gecko) "
                 "Chrome/122.0.0.0 Safari/537.36"
        )
        return {
            "User-Agent": ua,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            "DNT": "1",
            "Connection": "keep-alive",
            "Upgrade-Insecure-Requests": "1",
        }

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10),
        reraise=False,
    )
    def get(self, url: str, **kwargs) -> Optional[requests.Response]:
        try:
            resp = self._session.get(
                url,
                headers=self._headers(),
                timeout=REQUEST_TIMEOUT,
                allow_redirects=True,
                **kwargs,
            )
            if resp.status_code == 200:
                return resp
            logger.debug("HTTP %s for %s", resp.status_code, url)
            return None
        except requests.RequestException as exc:
            logger.debug("Request failed for %s: %s", url, exc)
            return None


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------

def _is_executive(text: str) -> bool:
    """Ritorna True se il testo contiene un titolo da decision maker."""
    text_upper = text.upper()
    return any(t.upper() in text_upper for t in EXECUTIVE_TITLES)


def _extract_linkedin_url(tag) -> str:
    """Estrae url linkedin da un tag HTML."""
    href = tag.get("href", "")
    if "linkedin.com/in/" in href or "linkedin.com/pub/" in href:
        return href
    return ""


def _clean_name(raw: str) -> str:
    return re.sub(r"\s+", " ", raw.strip())


def _clean_title(raw: str) -> str:
    return re.sub(r"\s+", " ", raw.strip())


# ---------------------------------------------------------------------------
# Strategia 1: scraping della leadership page aziendale
# ---------------------------------------------------------------------------

def _try_leadership_page(
    session: SmartSession,
    company: dict,
) -> list[DecisionMaker]:
    """Prova vari path /about /team /leadership e cerca person card."""
    domain = company["domain"]
    found: list[DecisionMaker] = []
    tried_urls: set[str] = set()

    for path in LEADERSHIP_PATHS:
        url = f"https://{domain}{path}"
        if url in tried_urls:
            continue
        tried_urls.add(url)

        resp = session.get(url)
        if not resp:
            continue

        soup = BeautifulSoup(resp.text, "lxml")

        # Rimuovi elementi non utili
        for tag in soup(["script", "style", "nav", "footer"]):
            tag.decompose()

        people = _parse_people_from_soup(soup, url, company)
        if people:
            found.extend(people)
            logger.info("[%s] Trovati %d exec su %s", company["name"], len(people), url)
            # Non continuare a cercare su altri path se abbiamo trovato qualcosa
            break

        _random_delay()

    return found


def _parse_people_from_soup(
    soup: BeautifulSoup,
    source_url: str,
    company: dict,
) -> list[DecisionMaker]:
    """Logica generica per estrarre person card da una pagina."""
    results: list[DecisionMaker] = []

    # --- Pattern A: schema.org Person markup ---
    for person_tag in soup.find_all(attrs={"itemtype": re.compile("schema.org/Person")}):
        name_tag = person_tag.find(attrs={"itemprop": "name"})
        title_tag = person_tag.find(attrs={"itemprop": re.compile("jobTitle|title")})
        if name_tag and title_tag:
            name = _clean_name(name_tag.get_text())
            title = _clean_title(title_tag.get_text())
            if name and _is_executive(title):
                results.append(DecisionMaker(
                    name=name, title=title,
                    company=company["name"], domain=company["domain"],
                    sector=company["sector"],
                    source_url=source_url, source="leadership_page",
                ))

    if results:
        return results

    # --- Pattern B: ricerca euristica per card/sezione con titolo exec ---
    # Cerca blocchi con heading + testo contenente titoli noti
    for heading in soup.find_all(["h1", "h2", "h3", "h4", "h5"]):
        heading_text = heading.get_text(" ", strip=True)
        # Il heading e' il nome? Cerca il titolo nel sibling/parent
        parent = heading.parent
        if not parent:
            continue
        parent_text = parent.get_text(" ", strip=True)
        if _is_executive(parent_text):
            # Cerca il titolo specifico
            for sib in list(heading.next_siblings)[:5]:
                sib_text = getattr(sib, "get_text", lambda **_: "")(" ", strip=True)
                if sib_text and _is_executive(sib_text):
                    name = _clean_name(heading_text)
                    title = _clean_title(sib_text[:120])
                    if name and len(name.split()) >= 2:
                        li_url = ""
                        for a in (parent.find_all("a") or []):
                            li_url = _extract_linkedin_url(a)
                            if li_url:
                                break
                        results.append(DecisionMaker(
                            name=name, title=title,
                            company=company["name"], domain=company["domain"],
                            sector=company["sector"],
                            linkedin_url=li_url,
                            source_url=source_url, source="leadership_page",
                        ))
                    break

    if results:
        return results

    # --- Pattern C: <p> o <div> con "CEO" | "CTO" ecc. vicino a un nome ---
    for tag in soup.find_all(["p", "div", "span", "li"]):
        text = tag.get_text(" ", strip=True)
        if not _is_executive(text):
            continue
        if len(text) > 250:
            continue
        # Cerca nome (pattern: due parole con iniziale maiuscola)
        names = re.findall(r"\b([A-Z][a-z]+ (?:[A-Z][a-z]+ )?[A-Z][a-z]+)\b", text)
        for name in names:
            title_match = re.search(
                r"(CEO|CTO|CFO|COO|CPO|CMO|CRO|CISO|President|Founder|"
                r"VP[^\n,]{0,40}|Director[^\n,]{0,40}|Head of[^\n,]{0,40})",
                text,
                re.IGNORECASE,
            )
            if title_match:
                li_url = ""
                for a in tag.find_all("a"):
                    li_url = _extract_linkedin_url(a)
                    if li_url:
                        break
                results.append(DecisionMaker(
                    name=_clean_name(name),
                    title=_clean_title(title_match.group(0)),
                    company=company["name"], domain=company["domain"],
                    sector=company["sector"],
                    linkedin_url=li_url,
                    source_url=source_url, source="leadership_page",
                ))

    # Dedup per nome
    seen: set[str] = set()
    unique: list[DecisionMaker] = []
    for dm in results:
        key = dm.name.lower()
        if key not in seen:
            seen.add(key)
            unique.append(dm)

    return unique


# ---------------------------------------------------------------------------
# Strategia 2: Google search pubblica (via SerpAPI se env var disponibile,
#              altrimenti fallback su ricerca HTML di DuckDuckGo)
# ---------------------------------------------------------------------------

def _search_via_duckduckgo(
    session: SmartSession,
    company: dict,
) -> list[DecisionMaker]:
    """
    Cerca '[company] CEO CTO leadership site:linkedin.com' su DuckDuckGo HTML.
    Estrattiamo i titoli e profili LinkedIn dai risultati.
    """
    results: list[DecisionMaker] = []
    query = f'"{company["name"]}" CEO OR CTO OR CFO site:linkedin.com/in'
    url = "https://html.duckduckgo.com/html/"

    resp = session.get(url, params={"q": query})
    if not resp:
        return results

    soup = BeautifulSoup(resp.text, "lxml")

    for result in soup.select(".result")[:10]:
        title_tag = result.select_one(".result__title")
        snippet_tag = result.select_one(".result__snippet")
        link_tag = result.select_one("a.result__url")

        if not title_tag:
            continue

        title_text = title_tag.get_text(" ", strip=True)
        snippet_text = snippet_tag.get_text(" ", strip=True) if snippet_tag else ""
        href = link_tag.get_text(strip=True) if link_tag else ""

        # Formato tipico LinkedIn: "Nome Cognome - CEO at Azienda | LinkedIn"
        li_match = re.match(
            r"^([A-Z][a-z]+(?: [A-Z][a-z.'-]+)+)\s*[-–|]\s*(.+?)(?:\s*[|]|$)",
            title_text,
        )
        if li_match:
            name = _clean_name(li_match.group(1))
            role_raw = li_match.group(2)
            if _is_executive(role_raw) or _is_executive(snippet_text):
                role = _clean_title(role_raw[:120])
                li_url = (
                    f"https://linkedin.com/in/{href.split('/')[-1]}"
                    if "linkedin.com/in/" in href else ""
                )
                results.append(DecisionMaker(
                    name=name, title=role,
                    company=company["name"], domain=company["domain"],
                    sector=company["sector"],
                    linkedin_url=li_url,
                    source_url=url, source="duckduckgo_search",
                ))

    _random_delay()
    return results


# ---------------------------------------------------------------------------
# Strategia 3: Crunchbase public org page
# ---------------------------------------------------------------------------

def _search_crunchbase(
    session: SmartSession,
    company: dict,
) -> list[DecisionMaker]:
    """
    Scraping della pagina pubblica Crunchbase /organization/<slug>/people.
    Slug = dominio senza TLD in prima approssimazione.
    """
    import tldextract
    extracted = tldextract.extract(company["domain"])
    slug = extracted.domain.lower().replace(" ", "-")

    url = f"https://www.crunchbase.com/organization/{slug}/people"
    resp = session.get(url)
    if not resp:
        return []

    soup = BeautifulSoup(resp.text, "lxml")
    results: list[DecisionMaker] = []

    # Crunchbase usa React SSR — proviamo a trovare dati JSON inline
    scripts = soup.find_all("script", type="application/json")
    for script in scripts:
        try:
            import json
            data = json.loads(script.string or "")
            # Naviga la struttura per trovare array di persone
            people_raw = _extract_people_from_json(data)
            for p in people_raw:
                name = p.get("name", "")
                title = p.get("title", "")
                li = p.get("linkedin", "")
                if name and _is_executive(title):
                    results.append(DecisionMaker(
                        name=_clean_name(name),
                        title=_clean_title(title),
                        company=company["name"], domain=company["domain"],
                        sector=company["sector"],
                        linkedin_url=li,
                        source_url=url, source="crunchbase",
                    ))
        except Exception:
            continue

    # Fallback: parsing HTML diretto
    if not results:
        for card in soup.select("[class*='person'], [class*='people'], [class*='team']"):
            name_tag = card.select_one("a, h3, h4, strong")
            title_tag = card.select_one("span, p, small")
            if name_tag and title_tag:
                name = _clean_name(name_tag.get_text())
                title = _clean_title(title_tag.get_text())
                if name and _is_executive(title):
                    results.append(DecisionMaker(
                        name=name, title=title,
                        company=company["name"], domain=company["domain"],
                        sector=company["sector"],
                        source_url=url, source="crunchbase",
                    ))

    _random_delay()
    return results


def _extract_people_from_json(data, _depth=0) -> list[dict]:
    """Naviga ricorsivamente un JSON Crunchbase per trovare oggetti persona."""
    if _depth > 8:
        return []
    results: list[dict] = []

    if isinstance(data, list):
        for item in data:
            results.extend(_extract_people_from_json(item, _depth + 1))
    elif isinstance(data, dict):
        name = data.get("full_name") or data.get("name") or data.get("firstName", "")
        title = data.get("title") or data.get("job_title") or data.get("primary_job_title", "")
        li = data.get("linkedin_url") or data.get("linkedin") or ""
        if name and title:
            results.append({"name": name, "title": title, "linkedin": li})
        for v in data.values():
            if isinstance(v, (dict, list)):
                results.extend(_extract_people_from_json(v, _depth + 1))

    return results


# ---------------------------------------------------------------------------
# Orchestratore
# ---------------------------------------------------------------------------

def _random_delay():
    time.sleep(random.uniform(*DELAY_BETWEEN_REQUESTS))


def scrape_company(
    session: SmartSession,
    company: dict,
    use_duckduckgo: bool = True,
    use_crunchbase: bool = True,
) -> list[DecisionMaker]:
    """Scrape tutti i decision maker di una singola azienda."""
    all_found: list[DecisionMaker] = []

    logger.info(">> Scraping %s (%s)", company["name"], company["domain"])

    # 1. Leadership page
    lp_results = _try_leadership_page(session, company)
    all_found.extend(lp_results)

    # 2. DuckDuckGo search (solo se non abbiamo gia' trovato abbastanza)
    if use_duckduckgo and len(all_found) < 3:
        ddg_results = _search_via_duckduckgo(session, company)
        all_found.extend(ddg_results)

    # 3. Crunchbase
    if use_crunchbase and len(all_found) < 3:
        cb_results = _search_crunchbase(session, company)
        all_found.extend(cb_results)

    # Dedup globale per nome + azienda
    seen: set[str] = set()
    unique: list[DecisionMaker] = []
    for dm in all_found:
        key = f"{dm.name.lower()}|{dm.company.lower()}"
        if key not in seen:
            seen.add(key)
            unique.append(dm)

    return unique


def scrape_all(
    companies: list[dict],
    max_companies: Optional[int] = None,
    use_duckduckgo: bool = True,
    use_crunchbase: bool = True,
) -> list[DecisionMaker]:
    """Scrape tutte le aziende e ritorna lista flat di DecisionMaker."""
    session = SmartSession()
    all_results: list[DecisionMaker] = []

    targets = companies[:max_companies] if max_companies else companies

    for i, company in enumerate(targets, 1):
        logger.info("[%d/%d] %s", i, len(targets), company["name"])
        try:
            results = scrape_company(session, company, use_duckduckgo, use_crunchbase)
            all_results.extend(results)
            logger.info(
                "    => %d decision maker trovati (totale: %d)",
                len(results), len(all_results),
            )
        except Exception as exc:
            logger.error("Errore su %s: %s", company["name"], exc)
        finally:
            _random_delay()

    return all_results
