"""
100 aziende piu' FIGHE del momento (2025-2026).
Mix di AI, tech, fintech, biotech, spazio, consumer — tutte con hype alto.
"""

TOP_100_COMPANIES = [
    # --- AI & LLM ---
    {"name": "Anthropic",          "domain": "anthropic.com",        "sector": "AI"},
    {"name": "OpenAI",             "domain": "openai.com",           "sector": "AI"},
    {"name": "xAI",                "domain": "x.ai",                 "sector": "AI"},
    {"name": "Mistral AI",         "domain": "mistral.ai",           "sector": "AI"},
    {"name": "Perplexity AI",      "domain": "perplexity.ai",        "sector": "AI"},
    {"name": "Cohere",             "domain": "cohere.com",           "sector": "AI"},
    {"name": "Together AI",        "domain": "together.ai",          "sector": "AI"},
    {"name": "Scale AI",           "domain": "scale.com",            "sector": "AI"},
    {"name": "Inflection AI",      "domain": "inflection.ai",        "sector": "AI"},
    {"name": "Runway",             "domain": "runwayml.com",         "sector": "AI"},
    {"name": "Pika Labs",          "domain": "pika.art",             "sector": "AI"},
    {"name": "ElevenLabs",         "domain": "elevenlabs.io",        "sector": "AI"},
    {"name": "Midjourney",         "domain": "midjourney.com",       "sector": "AI"},
    {"name": "Harvey AI",          "domain": "harvey.ai",            "sector": "AI"},
    {"name": "Cognition AI",       "domain": "cognition.ai",         "sector": "AI"},
    {"name": "Cursor",             "domain": "cursor.com",           "sector": "AI"},
    {"name": "Glean",              "domain": "glean.com",            "sector": "AI"},
    {"name": "Coframe",            "domain": "coframe.com",          "sector": "AI"},
    {"name": "Imbue",              "domain": "imbue.com",            "sector": "AI"},
    {"name": "Aleph Alpha",        "domain": "aleph-alpha.com",      "sector": "AI"},

    # --- Developer Tools & Infra ---
    {"name": "Vercel",             "domain": "vercel.com",           "sector": "DevTools"},
    {"name": "Linear",             "domain": "linear.app",           "sector": "DevTools"},
    {"name": "Supabase",           "domain": "supabase.com",         "sector": "DevTools"},
    {"name": "Neon",               "domain": "neon.tech",            "sector": "DevTools"},
    {"name": "PlanetScale",        "domain": "planetscale.com",      "sector": "DevTools"},
    {"name": "Turso",              "domain": "turso.tech",           "sector": "DevTools"},
    {"name": "Railway",            "domain": "railway.app",          "sector": "DevTools"},
    {"name": "Render",             "domain": "render.com",           "sector": "DevTools"},
    {"name": "Temporal",           "domain": "temporal.io",          "sector": "DevTools"},
    {"name": "Warp",               "domain": "warp.dev",             "sector": "DevTools"},

    # --- Produttivita' & Collaboration ---
    {"name": "Notion",             "domain": "notion.so",            "sector": "Productivity"},
    {"name": "Figma",              "domain": "figma.com",            "sector": "Productivity"},
    {"name": "Loom",               "domain": "loom.com",             "sector": "Productivity"},
    {"name": "Coda",               "domain": "coda.io",              "sector": "Productivity"},
    {"name": "Airtable",           "domain": "airtable.com",         "sector": "Productivity"},
    {"name": "Retool",             "domain": "retool.com",           "sector": "Productivity"},
    {"name": "Miro",               "domain": "miro.com",             "sector": "Productivity"},
    {"name": "Webflow",            "domain": "webflow.com",          "sector": "Productivity"},
    {"name": "Framer",             "domain": "framer.com",           "sector": "Productivity"},
    {"name": "Height",             "domain": "height.app",           "sector": "Productivity"},

    # --- Fintech ---
    {"name": "Stripe",             "domain": "stripe.com",           "sector": "Fintech"},
    {"name": "Brex",               "domain": "brex.com",             "sector": "Fintech"},
    {"name": "Ramp",               "domain": "ramp.com",             "sector": "Fintech"},
    {"name": "Rippling",           "domain": "rippling.com",         "sector": "Fintech"},
    {"name": "Mercury",            "domain": "mercury.com",          "sector": "Fintech"},
    {"name": "Deel",               "domain": "deel.com",             "sector": "Fintech"},
    {"name": "Plaid",              "domain": "plaid.com",            "sector": "Fintech"},
    {"name": "Adyen",              "domain": "adyen.com",            "sector": "Fintech"},
    {"name": "Wise",               "domain": "wise.com",             "sector": "Fintech"},
    {"name": "Chime",              "domain": "chime.com",            "sector": "Fintech"},

    # --- Crypto & Web3 ---
    {"name": "Coinbase",           "domain": "coinbase.com",         "sector": "Crypto"},
    {"name": "Alchemy",            "domain": "alchemy.com",          "sector": "Crypto"},
    {"name": "Chainalysis",        "domain": "chainalysis.com",      "sector": "Crypto"},
    {"name": "Fireblocks",         "domain": "fireblocks.com",       "sector": "Crypto"},
    {"name": "Ledger",             "domain": "ledger.com",           "sector": "Crypto"},

    # --- Spazio & DeepTech ---
    {"name": "SpaceX",             "domain": "spacex.com",           "sector": "Space"},
    {"name": "Rocket Lab",         "domain": "rocketlabusa.com",     "sector": "Space"},
    {"name": "Relativity Space",   "domain": "relativityspace.com",  "sector": "Space"},
    {"name": "Axiom Space",        "domain": "axiomspace.com",       "sector": "Space"},
    {"name": "Planet Labs",        "domain": "planet.com",           "sector": "Space"},

    # --- Biotech & HealthTech ---
    {"name": "Neuralink",          "domain": "neuralink.com",        "sector": "Biotech"},
    {"name": "Ginkgo Bioworks",    "domain": "ginkgobioworks.com",   "sector": "Biotech"},
    {"name": "Recursion",          "domain": "recursion.com",        "sector": "Biotech"},
    {"name": "Insitro",            "domain": "insitro.com",          "sector": "Biotech"},
    {"name": "Insilico Medicine",  "domain": "insilico.com",         "sector": "Biotech"},
    {"name": "Hims & Hers",        "domain": "forhims.com",          "sector": "HealthTech"},
    {"name": "Carbon Health",      "domain": "carbonhealth.com",     "sector": "HealthTech"},
    {"name": "Ro Health",          "domain": "ro.co",                "sector": "HealthTech"},
    {"name": "Nuvation Bio",       "domain": "nuvationbio.com",      "sector": "Biotech"},
    {"name": "Generate Biomedicines", "domain": "generatebiomedicines.com", "sector": "Biotech"},

    # --- EV & CleanTech ---
    {"name": "Rivian",             "domain": "rivian.com",           "sector": "EV"},
    {"name": "Lucid Motors",       "domain": "lucidmotors.com",      "sector": "EV"},
    {"name": "Archer Aviation",    "domain": "archer.com",           "sector": "EV"},
    {"name": "Joby Aviation",      "domain": "jobyaviation.com",     "sector": "EV"},
    {"name": "Northvolt",          "domain": "northvolt.com",        "sector": "CleanTech"},
    {"name": "Commonwealth Fusion","domain": "cfs.energy",           "sector": "CleanTech"},
    {"name": "Helion Energy",      "domain": "helionenergy.com",     "sector": "CleanTech"},
    {"name": "Form Energy",        "domain": "formenergy.com",       "sector": "CleanTech"},
    {"name": "Solugen",            "domain": "solugen.com",          "sector": "CleanTech"},
    {"name": "Twelve",             "domain": "twelve.co",            "sector": "CleanTech"},

    # --- Consumer & Social ---
    {"name": "Duolingo",           "domain": "duolingo.com",         "sector": "Consumer"},
    {"name": "Canva",              "domain": "canva.com",            "sector": "Consumer"},
    {"name": "BeReal",             "domain": "bere.al",              "sector": "Social"},
    {"name": "Discord",            "domain": "discord.com",          "sector": "Social"},
    {"name": "Substack",           "domain": "substack.com",         "sector": "Media"},
    {"name": "Beehiiv",            "domain": "beehiiv.com",          "sector": "Media"},
    {"name": "Luma AI",            "domain": "lumalabs.ai",          "sector": "AI"},
    {"name": "Character AI",       "domain": "character.ai",         "sector": "AI"},
    {"name": "Replika",            "domain": "replika.ai",           "sector": "AI"},
    {"name": "Roblox",             "domain": "roblox.com",           "sector": "Gaming"},

    # --- Robotics & Hardware ---
    {"name": "Figure AI",          "domain": "figure.ai",            "sector": "Robotics"},
    {"name": "1X Technologies",    "domain": "1x.tech",              "sector": "Robotics"},
    {"name": "Boston Dynamics",    "domain": "bostondynamics.com",   "sector": "Robotics"},
    {"name": "Apptronik",          "domain": "apptronik.com",        "sector": "Robotics"},
    {"name": "Bright Machines",    "domain": "brightmachines.com",   "sector": "Robotics"},

    # --- Cybersecurity ---
    {"name": "Wiz",                "domain": "wiz.io",               "sector": "Security"},
    {"name": "Cyera",              "domain": "cyera.io",             "sector": "Security"},
    {"name": "Lacework",           "domain": "lacework.com",         "sector": "Security"},
    {"name": "Orca Security",      "domain": "orca.security",        "sector": "Security"},
    {"name": "Snyk",               "domain": "snyk.io",              "sector": "Security"},
]
