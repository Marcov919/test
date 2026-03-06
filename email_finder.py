"""
Email Finder
============
Trova o inferisce l'email di un decision maker dato nome + dominio aziendale.

Strategie:
  1. Scraping diretto di /contact /press /about per email esplicite nel sito
  2. Pattern generation (formati email piu' comuni)
  3. Hunter.io API (opzionale, richiede HUNTER_API_KEY in .env)
"""

import os
import re
import logging
from itertools import product
from typing import Optional

import requests
from tenacity import retry, stop_after_attempt, wait_exponential

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Formati email piu' comuni per aziende tech
# ---------------------------------------------------------------------------

def generate_email_candidates(first: str, last: str, domain: str) -> list[str]:
    """
    Genera tutti i formati email plausibili per un nome + dominio.
    Ordinati dal piu' comune al meno comune (fonte: Hunter.io statistics).
    """
    f = first.lower().strip()
    l = last.lower().strip()
    fi = f[0] if f else ""
    li = l[0] if l else ""

    if not f or not l:
        return []

    patterns = [
        f"{f}@{domain}",               # john@stripe.com        (30%)
        f"{f}.{l}@{domain}",           # john.smith@stripe.com  (25%)
        f"{fi}{l}@{domain}",           # jsmith@stripe.com      (15%)
        f"{f}{l}@{domain}",            # johnsmith@stripe.com   (10%)
        f"{fi}.{l}@{domain}",          # j.smith@stripe.com     (8%)
        f"{l}.{f}@{domain}",           # smith.john@stripe.com  (4%)
        f"{l}{fi}@{domain}",           # smithj@stripe.com      (3%)
        f"{f}_{l}@{domain}",           # john_smith@stripe.com  (2%)
        f"{f}-{l}@{domain}",           # john-smith@stripe.com  (1%)
        f"{fi}{li}@{domain}",          # js@stripe.com          (raro)
    ]
    return patterns


def split_name(full_name: str) -> tuple[str, str]:
    """Divide nome completo in (first, last). Gestisce nomi composti."""
    parts = full_name.strip().split()
    if len(parts) == 0:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    # Prende primo e ultimo token (ignora secondo nome)
    return parts[0], parts[-1]


# ---------------------------------------------------------------------------
# Scraping email dalla pagina pubblica del sito
# ---------------------------------------------------------------------------

CONTACT_PATHS = [
    "/contact", "/contact-us", "/press", "/media",
    "/about", "/about-us", "/team", "/hello",
    "/careers", "/investors",
]

EMAIL_REGEX = re.compile(
    r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}",
    re.IGNORECASE,
)


def scrape_emails_from_site(session, domain: str) -> set[str]:
    """
    Visita alcune pagine del sito e raccoglie tutte le email trovate.
    Filtra email generiche (info@, support@, ecc.) per tenere solo quelle personali.
    """
    found: set[str] = set()
    generic_prefixes = {
        "info", "contact", "hello", "hi", "support", "help",
        "team", "press", "media", "noreply", "no-reply",
        "legal", "privacy", "security", "jobs", "careers",
        "sales", "billing", "admin", "postmaster",
    }

    for path in CONTACT_PATHS:
        url = f"https://{domain}{path}"
        resp = session.get(url)
        if not resp:
            continue

        emails = EMAIL_REGEX.findall(resp.text)
        for email in emails:
            prefix = email.split("@")[0].lower()
            email_domain = email.split("@")[1].lower()
            # Tieni solo email sullo stesso dominio e non generiche
            if domain in email_domain and prefix not in generic_prefixes:
                found.add(email.lower())

    return found


def _infer_domain_format(known_emails: set[str], domain: str) -> Optional[str]:
    """
    Dato un set di email trovate sul sito, inferisce il formato dominante.
    Ritorna il pattern piu' frequente (es. '{first}.{last}').
    """
    if not known_emails:
        return None

    pattern_counts: dict[str, int] = {}

    for email in known_emails:
        prefix = email.split("@")[0]
        # Cerca pattern con punto
        if "." in prefix:
            parts = prefix.split(".")
            if len(parts) == 2:
                a, b = parts
                if len(a) == 1:
                    pattern_counts["{fi}.{last}"] = pattern_counts.get("{fi}.{last}", 0) + 1
                elif len(b) == 1:
                    pattern_counts["{first}.{li}"] = pattern_counts.get("{first}.{li}", 0) + 1
                else:
                    pattern_counts["{first}.{last}"] = pattern_counts.get("{first}.{last}", 0) + 1
        elif len(prefix) <= 2:
            pattern_counts["{fi}{li}"] = pattern_counts.get("{fi}{li}", 0) + 1
        else:
            pattern_counts["{first}"] = pattern_counts.get("{first}", 0) + 1

    if not pattern_counts:
        return None
    return max(pattern_counts, key=pattern_counts.get)


# ---------------------------------------------------------------------------
# Hunter.io API (opzionale)
# ---------------------------------------------------------------------------

HUNTER_API_KEY = os.getenv("HUNTER_API_KEY", "")


@retry(stop=stop_after_attempt(2), wait=wait_exponential(min=2, max=6), reraise=False)
def hunter_find_email(first: str, last: str, domain: str) -> Optional[str]:
    """
    Usa Hunter.io Email Finder API per trovare l'email verificata.
    Richiede HUNTER_API_KEY nell'ambiente (piano gratuito: 25 ricerche/mese).
    """
    if not HUNTER_API_KEY:
        return None
    try:
        resp = requests.get(
            "https://api.hunter.io/v2/email-finder",
            params={
                "domain": domain,
                "first_name": first,
                "last_name": last,
                "api_key": HUNTER_API_KEY,
            },
            timeout=10,
        )
        data = resp.json()
        email = data.get("data", {}).get("email")
        confidence = data.get("data", {}).get("score", 0)
        if email and confidence >= 50:
            logger.debug("Hunter.io: %s (confidence %d%%)", email, confidence)
            return email
    except Exception as exc:
        logger.debug("Hunter.io error: %s", exc)
    return None


@retry(stop=stop_after_attempt(2), wait=wait_exponential(min=2, max=6), reraise=False)
def hunter_domain_search(domain: str) -> list[dict]:
    """
    Usa Hunter.io Domain Search per trovare tutte le email note per un dominio.
    Ritorna lista di {email, first_name, last_name, position, confidence}.
    """
    if not HUNTER_API_KEY:
        return []
    try:
        resp = requests.get(
            "https://api.hunter.io/v2/domain-search",
            params={
                "domain": domain,
                "limit": 10,
                "api_key": HUNTER_API_KEY,
            },
            timeout=10,
        )
        data = resp.json()
        emails_data = data.get("data", {}).get("emails", [])
        results = []
        for e in emails_data:
            results.append({
                "email": e.get("value", ""),
                "first_name": e.get("first_name", ""),
                "last_name": e.get("last_name", ""),
                "position": e.get("position", ""),
                "confidence": e.get("confidence", 0),
                "linkedin_url": e.get("linkedin", ""),
            })
        return results
    except Exception as exc:
        logger.debug("Hunter.io domain search error: %s", exc)
    return []


# ---------------------------------------------------------------------------
# Orchestratore principale
# ---------------------------------------------------------------------------

# Cache per non ri-scrapare lo stesso dominio piu' volte
_site_emails_cache: dict[str, set[str]] = {}
_domain_format_cache: dict[str, Optional[str]] = {}


def find_email(
    session,
    full_name: str,
    domain: str,
    use_hunter: bool = True,
) -> str:
    """
    Trova la migliore email per un decision maker.
    Ritorna stringa vuota se non trova nulla di affidabile.

    Priorita':
      1. Hunter.io API (se disponibile) — email verificata
      2. Email trovata direttamente nel sito con nome corrispondente
      3. Candidate generata dal formato inferito dal sito
      4. Candidate piu' probabile statistica (first.last@domain)
    """
    first, last = split_name(full_name)
    if not first or not last:
        return ""

    # 1. Hunter.io (massima affidabilita')
    if use_hunter and HUNTER_API_KEY:
        email = hunter_find_email(first, last, domain)
        if email:
            return email

    # 2. Scraping email dal sito (con cache per dominio)
    if domain not in _site_emails_cache:
        _site_emails_cache[domain] = scrape_emails_from_site(session, domain)
        _domain_format_cache[domain] = _infer_domain_format(
            _site_emails_cache[domain], domain
        )

    site_emails = _site_emails_cache[domain]

    # Cerca email che contiene il nome o cognome della persona
    fn_lower = first.lower()
    ln_lower = last.lower()
    for email in site_emails:
        prefix = email.split("@")[0].lower()
        if fn_lower in prefix or ln_lower in prefix:
            return email

    # 3. Usa il formato inferito dal sito
    inferred_format = _domain_format_cache.get(domain)
    if inferred_format:
        fi = first[0].lower()
        li = last[0].lower()
        candidate = (
            inferred_format
            .replace("{first}", first.lower())
            .replace("{last}", last.lower())
            .replace("{fi}", fi)
            .replace("{li}", li)
            + f"@{domain}"
        )
        return candidate + "  [pattern]"  # segnalo che e' generata

    # 4. Fallback: formato statisticamente piu' comune
    candidates = generate_email_candidates(first, last, domain)
    if candidates:
        return candidates[0] + "  [pattern]"

    return ""


def enrich_with_emails(session, decision_makers: list, use_hunter: bool = True) -> list:
    """
    Arricchisce una lista di DecisionMaker con il campo email.
    Modifica gli oggetti in-place e li ritorna.
    """
    from scraper import DecisionMaker

    # Se Hunter.io e' disponibile, usa prima domain search (piu' efficiente)
    if use_hunter and HUNTER_API_KEY:
        domains_searched: set[str] = set()
        hunter_by_name: dict[str, str] = {}

        for dm in decision_makers:
            if dm.domain in domains_searched:
                continue
            domains_searched.add(dm.domain)
            hunter_results = hunter_domain_search(dm.domain)
            for r in hunter_results:
                full = f"{r['first_name']} {r['last_name']}".strip().lower()
                if r["email"]:
                    hunter_by_name[full] = r["email"]
                    # Aggiorna anche linkedin se mancante
                    if r.get("linkedin_url"):
                        for d in decision_makers:
                            if d.name.lower() == full and not d.linkedin_url:
                                d.linkedin_url = r["linkedin_url"]

        for dm in decision_makers:
            key = dm.name.lower()
            if key in hunter_by_name:
                dm.email = hunter_by_name[key]
            else:
                dm.email = find_email(session, dm.name, dm.domain, use_hunter=True)
    else:
        for dm in decision_makers:
            dm.email = find_email(session, dm.name, dm.domain, use_hunter=False)

    return decision_makers
