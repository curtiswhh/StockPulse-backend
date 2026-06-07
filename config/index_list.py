"""
Index List — GOLD SOURCE for the prominent market indices we track.
========================================================

This file is the single source of truth for which indices the pipeline
scrapes. Hand-edit INDEX_LIST to add or remove an index.

FLOW:
  index_list.py  →  synced into the `index_list` Supabase table each run
                    (IndexTracker.sync — upserts present rows, soft-deletes
                     symbols no longer here)  →  pipeline scrapes Yahoo for
                    every active row  →  index_price / index_return.

SYMBOLS:
  `symbol` is the native Yahoo Finance ticker (e.g. '^GSPC'), stored verbatim
  and used as the primary key across index_list / index_price / index_return.
  yfinance accepts these directly — no canonical/vendor mapping involved.

  Seeded from Yahoo Finance → Markets → World Indices.
"""

INDEX_LIST: list[dict] = [
    {"symbol": "^GSPC",            "name": "S&P 500",                              "region": "US"},
    {"symbol": "^DJI",             "name": "Dow Jones Industrial Average",         "region": "US"},
    {"symbol": "^IXIC",            "name": "NASDAQ Composite",                     "region": "US"},
    {"symbol": "^NYA",             "name": "NYSE Composite Index",                 "region": "US"},
    {"symbol": "^XAX",             "name": "NYSE American Composite Index",        "region": "US"},
    {"symbol": "^RUT",             "name": "Russell 2000 Index",                   "region": "US"},
    {"symbol": "^VIX",             "name": "CBOE Volatility Index",                "region": "US"},
    {"symbol": "^BUK100P",         "name": "Cboe UK 100",                          "region": "Europe"},
    {"symbol": "^FTSE",            "name": "FTSE 100",                             "region": "Europe"},
    {"symbol": "^GDAXI",           "name": "DAX P",                                "region": "Europe"},
    {"symbol": "^FCHI",            "name": "CAC 40",                               "region": "Europe"},
    {"symbol": "^STOXX50E",        "name": "EURO STOXX 50",                        "region": "Europe"},
    {"symbol": "^N100",            "name": "Euronext 100 Index",                   "region": "Europe"},
    {"symbol": "^BFX",             "name": "BEL 20",                               "region": "Europe"},
    {"symbol": "^HSI",             "name": "HANG SENG INDEX",                      "region": "Asia"},
    {"symbol": "^STI",             "name": "STI Index",                            "region": "Asia"},
    {"symbol": "^AXJO",            "name": "S&P/ASX 200",                          "region": "Asia"},
    {"symbol": "^AORD",            "name": "ALL ORDINARIES",                       "region": "Asia"},
    {"symbol": "^BSESN",           "name": "S&P BSE SENSEX",                       "region": "Asia"},
    {"symbol": "^JKSE",            "name": "IDX COMPOSITE",                        "region": "Asia"},
    {"symbol": "^KLSE",            "name": "FTSE Bursa Malaysia KLCI",             "region": "Asia"},
    {"symbol": "^NZ50",            "name": "S&P/NZX 50 INDEX GROSS",               "region": "Asia"},
    {"symbol": "^KS11",            "name": "KOSPI Composite Index",                "region": "Asia"},
    {"symbol": "^TWII",            "name": "TWSE Capitalization Weighted Stock Index", "region": "Asia"},
    {"symbol": "^GSPTSE",          "name": "S&P/TSX Composite Index",              "region": "Americas"},
    {"symbol": "^BVSP",            "name": "IBOVESPA",                             "region": "Americas"},
    {"symbol": "^MXX",             "name": "IPC MEXICO",                           "region": "Americas"},
    {"symbol": "^MERV",            "name": "MERVAL",                               "region": "Americas"},
    {"symbol": "^TA125.TA",        "name": "TA-125",                              "region": "Middle East"},
    {"symbol": "^JN0U.JO",         "name": "Top 40 USD Net TRI Index",            "region": "Africa"},
    {"symbol": "DX-Y.NYB",         "name": "US Dollar Index",                      "region": "Currency"},
    {"symbol": "^125904-USD-STRD", "name": "MSCI EUROPE",                          "region": "Europe"},
    {"symbol": "^XDB",             "name": "British Pound Currency Index",         "region": "Currency"},
    {"symbol": "^XDE",             "name": "Euro Currency Index",                  "region": "Currency"},
    {"symbol": "000001.SS",        "name": "SSE Composite Index",                  "region": "Asia"},
    {"symbol": "^N225",            "name": "Nikkei 225",                           "region": "Asia"},
    {"symbol": "^XDN",             "name": "Japanese Yen Currency Index",          "region": "Currency"},
    {"symbol": "^XDA",             "name": "Australian Dollar Currency Index",     "region": "Currency"},
]