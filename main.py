#!/usr/bin/env python3
"""
Decision Maker Scraper CLI
==========================
Trova CEO, CTO, CFO e altri exec nelle 100 aziende piu' fighe del momento,
con email e profilo LinkedIn.

Uso rapido:
    python main.py                          # scrapa tutte le 100 aziende
    python main.py --limit 10              # prime 10 aziende
    python main.py --sector AI             # solo aziende AI
    python main.py --out results.csv       # salva in CSV (apri con Excel)
    python main.py --out results.json      # salva in JSON
    python main.py --no-ddg --no-cb        # solo leadership page
    python main.py --no-hunter             # senza Hunter.io API
"""

import argparse
import json
import logging
import sys
from pathlib import Path

import pandas as pd
from rich.console import Console
from rich.table import Table
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn
from rich.logging import RichHandler
from rich import print as rprint

from companies import TOP_100_COMPANIES
from scraper import DecisionMaker, SmartSession, scrape_company
from email_finder import enrich_with_emails

console = Console()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Scraper dei decision maker nelle 100 aziende piu' fighe",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument(
        "--limit", "-n", type=int, default=None,
        help="Numero massimo di aziende da processare (default: tutte)",
    )
    p.add_argument(
        "--sector", "-s", type=str, default=None,
        help="Filtra per settore (es. AI, Fintech, Biotech, ...)",
    )
    p.add_argument(
        "--company", "-c", type=str, default=None,
        help="Cerca solo una specifica azienda (partial match sul nome)",
    )
    p.add_argument(
        "--out", "-o", type=str, default=None,
        help="File di output: .csv o .json (default: stampa a schermo)",
    )
    p.add_argument(
        "--no-ddg", action="store_true",
        help="Disabilita la ricerca via DuckDuckGo",
    )
    p.add_argument(
        "--no-cb", action="store_true",
        help="Disabilita lo scraping di Crunchbase",
    )
    p.add_argument(
        "--no-hunter", action="store_true",
        help="Disabilita Hunter.io API (usa solo scraping + pattern)",
    )
    p.add_argument(
        "--verbose", "-v", action="store_true",
        help="Log dettagliato",
    )
    p.add_argument(
        "--list-sectors", action="store_true",
        help="Stampa tutti i settori disponibili ed esce",
    )
    p.add_argument(
        "--list-companies", action="store_true",
        help="Stampa le 100 aziende ed esce",
    )
    return p


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

def print_companies_table(companies: list[dict]) -> None:
    table = Table(title="100 Aziende Piu' Fighe del Momento", show_lines=True)
    table.add_column("#", style="dim", width=4)
    table.add_column("Azienda", style="bold cyan")
    table.add_column("Settore", style="magenta")
    table.add_column("Dominio", style="green")
    for i, c in enumerate(companies, 1):
        table.add_row(str(i), c["name"], c["sector"], c["domain"])
    console.print(table)


def print_results_table(results: list[DecisionMaker]) -> None:
    if not results:
        rprint("[yellow]Nessun decision maker trovato.[/yellow]")
        return

    table = Table(
        title=f"Decision Makers Trovati ({len(results)})",
        show_lines=True,
        expand=True,
    )
    table.add_column("Nome", style="bold white", min_width=18)
    table.add_column("Titolo", style="cyan", min_width=18)
    table.add_column("Azienda", style="green", min_width=14)
    table.add_column("Settore", style="magenta", width=11)
    table.add_column("Email", style="yellow", min_width=26)
    table.add_column("LinkedIn", style="blue", width=10)
    table.add_column("Fonte", style="dim", width=16)

    for dm in results:
        li = (
            f"[link={dm.linkedin_url}]Profilo[/link]"
            if dm.linkedin_url else "[dim]n/a[/dim]"
        )
        email_display = dm.email if dm.email else "[dim]n/a[/dim]"
        table.add_row(
            dm.name, dm.title, dm.company,
            dm.sector, email_display, li, dm.source,
        )

    console.print(table)


def save_csv(results: list[DecisionMaker], path: str) -> None:
    df = pd.DataFrame([dm.to_dict() for dm in results])
    # Riordina colonne per leggibilita'
    cols = ["name", "title", "company", "sector", "email", "linkedin_url",
            "domain", "source", "source_url"]
    df = df[[c for c in cols if c in df.columns]]
    df.to_csv(path, index=False, encoding="utf-8")
    rprint(f"[green]CSV salvato in: {path}[/green]")
    rprint(f"[dim]Aprilo con Excel o Google Sheets.[/dim]")


def save_json(results: list[DecisionMaker], path: str) -> None:
    data = [dm.to_dict() for dm in results]
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    rprint(f"[green]JSON salvato in: {path}[/green]")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    level = logging.DEBUG if args.verbose else logging.WARNING
    logging.basicConfig(
        level=level,
        format="%(message)s",
        handlers=[RichHandler(rich_tracebacks=True, show_path=False)],
    )

    if args.list_sectors:
        sectors = sorted(set(c["sector"] for c in TOP_100_COMPANIES))
        rprint("[bold]Settori disponibili:[/bold]")
        for s in sectors:
            count = sum(1 for c in TOP_100_COMPANIES if c["sector"] == s)
            rprint(f"  [cyan]{s}[/cyan] ({count} aziende)")
        return 0

    if args.list_companies:
        print_companies_table(TOP_100_COMPANIES)
        return 0

    # Filtraggio aziende
    companies = list(TOP_100_COMPANIES)

    if args.sector:
        companies = [c for c in companies if c["sector"].lower() == args.sector.lower()]
        if not companies:
            rprint(f"[red]Nessuna azienda nel settore '{args.sector}'.[/red]")
            rprint("Usa --list-sectors per vedere i settori disponibili.")
            return 1

    if args.company:
        companies = [c for c in companies if args.company.lower() in c["name"].lower()]
        if not companies:
            rprint(f"[red]Nessuna azienda trovata con nome '{args.company}'.[/red]")
            return 1

    if args.limit:
        companies = companies[: args.limit]

    rprint(
        f"\n[bold cyan]Decision Maker Scraper[/bold cyan] "
        f"[dim]— {len(companies)} aziende da processare[/dim]\n"
    )

    # --- Fase 1: scraping decision makers ---
    all_results: list[DecisionMaker] = []
    session = SmartSession()

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
        transient=True,
    ) as progress:
        task = progress.add_task("Fase 1/2 — Scraping persone...", total=len(companies))
        for i, company in enumerate(companies, 1):
            progress.update(
                task,
                description=f"[cyan]{company['name']}[/cyan] ({i}/{len(companies)})",
                advance=1,
            )
            try:
                results = scrape_company(
                    session, company,
                    use_duckduckgo=not args.no_ddg,
                    use_crunchbase=not args.no_cb,
                )
                all_results.extend(results)
            except Exception as exc:
                logging.error("Errore su %s: %s", company["name"], exc)

    rprint(f"[dim]Trovati {len(all_results)} decision maker. Cerco le email...[/dim]")

    # --- Fase 2: arricchimento email ---
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        console=console,
        transient=True,
    ) as progress:
        progress.add_task("Fase 2/2 — Ricerca email...", total=None)
        try:
            enrich_with_emails(
                session,
                all_results,
                use_hunter=not args.no_hunter,
            )
        except Exception as exc:
            logging.error("Errore durante enrichment email: %s", exc)

    # --- Output ---
    if args.out:
        out_path = Path(args.out)
        if out_path.suffix.lower() == ".json":
            save_json(all_results, str(out_path))
        else:
            save_csv(all_results, str(out_path))
    else:
        print_results_table(all_results)

    emails_found = sum(1 for dm in all_results if dm.email)
    rprint(
        f"\n[bold green]Completato![/bold green] "
        f"{len(all_results)} persone trovate, "
        f"{emails_found} con email, "
        f"in {len(companies)} aziende.\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
