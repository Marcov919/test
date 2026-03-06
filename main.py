#!/usr/bin/env python3
"""
Decision Maker Scraper CLI
==========================
Trova CEO, CTO, CFO e altri exec nelle 100 aziende piu' fighe del momento.

Uso rapido:
    python main.py                          # scrapa tutte le 100 aziende
    python main.py --limit 10              # prime 10 aziende
    python main.py --sector AI             # solo aziende AI
    python main.py --out results.csv       # salva in CSV
    python main.py --out results.json      # salva in JSON
    python main.py --no-ddg --no-cb        # solo leadership page
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
from scraper import scrape_all, DecisionMaker

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
    table.add_column("Nome", style="bold white", min_width=20)
    table.add_column("Titolo", style="cyan", min_width=20)
    table.add_column("Azienda", style="green", min_width=15)
    table.add_column("Settore", style="magenta", width=12)
    table.add_column("LinkedIn", style="blue", min_width=10)
    table.add_column("Fonte", style="dim", width=18)

    for dm in results:
        li = (
            f"[link={dm.linkedin_url}]Profilo[/link]"
            if dm.linkedin_url else "[dim]n/a[/dim]"
        )
        table.add_row(
            dm.name, dm.title, dm.company,
            dm.sector, li, dm.source,
        )

    console.print(table)


def save_csv(results: list[DecisionMaker], path: str) -> None:
    df = pd.DataFrame([dm.to_dict() for dm in results])
    df.to_csv(path, index=False, encoding="utf-8")
    rprint(f"[green]CSV salvato in: {path}[/green]")


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

    # Setup logging
    level = logging.DEBUG if args.verbose else logging.WARNING
    logging.basicConfig(
        level=level,
        format="%(message)s",
        handlers=[RichHandler(rich_tracebacks=True, show_path=False)],
    )

    # Comandi informativi
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
    companies = TOP_100_COMPANIES

    if args.sector:
        companies = [c for c in companies if c["sector"].lower() == args.sector.lower()]
        if not companies:
            rprint(f"[red]Nessuna azienda nel settore '{args.sector}'.[/red]")
            rprint("Usa --list-sectors per vedere i settori disponibili.")
            return 1

    if args.company:
        companies = [
            c for c in companies
            if args.company.lower() in c["name"].lower()
        ]
        if not companies:
            rprint(f"[red]Nessuna azienda trovata con nome '{args.company}'.[/red]")
            return 1

    if args.limit:
        companies = companies[: args.limit]

    # Banner
    rprint(
        f"\n[bold cyan]Decision Maker Scraper[/bold cyan] "
        f"[dim]— {len(companies)} aziende da processare[/dim]\n"
    )

    # Avvio scraping
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
        transient=True,
    ) as progress:
        task = progress.add_task("Scraping in corso...", total=len(companies))

        all_results: list[DecisionMaker] = []
        for i, company in enumerate(companies, 1):
            progress.update(
                task,
                description=f"[cyan]{company['name']}[/cyan] ({i}/{len(companies)})",
                advance=1,
            )
            try:
                from scraper import SmartSession, scrape_company
                session = SmartSession()
                results = scrape_company(
                    session, company,
                    use_duckduckgo=not args.no_ddg,
                    use_crunchbase=not args.no_cb,
                )
                all_results.extend(results)
            except Exception as exc:
                logging.error("Errore su %s: %s", company["name"], exc)

    # Output
    if args.out:
        out_path = Path(args.out)
        if out_path.suffix.lower() == ".json":
            save_json(all_results, str(out_path))
        else:
            save_csv(all_results, str(out_path))
    else:
        print_results_table(all_results)

    rprint(
        f"\n[bold green]Completato![/bold green] "
        f"{len(all_results)} decision maker trovati in {len(companies)} aziende.\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
