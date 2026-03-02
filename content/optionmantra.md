# OptionMantra: VIX Data Pipeline - A Practical, Everyday Build

**By Madhu** | March 2, 2026 | 8 min read

---

## Table of Contents
1. [The Big Picture](#big-picture)
2. [The Problem](#problem)
3. [The Vision](#vision)
4. [How The Pieces Fit Together](#architecture)
5. [Data Shape & Storage](#data-shape)
6. [What's Done](#done)
7. [Tech Stack](#tech-stack)
8. [Performance & Cost](#performance)
9. [Learnings](#learnings)
10. [What's Next](#roadmap)
11. [Final Thoughts](#final-thoughts)
12. [Screenshots](#screenshots)

---

## <a id="big-picture"></a>The Big Picture

I wanted a clean, reliable way to track VIX at 5-minute resolution without babysitting it every day. The result is a small pipeline that blends historical candles from Yahoo Finance with live quotes from Tastytrade, then stores everything in Google Cloud Storage (GCS) so it is easy to query later.

This write-up is the short, human version of what the app does and what is already working.

**What it does:**
- **Historical backbone**: Grab 5-minute candles and keep them in a local SQLite database
- **Live updates**: During market hours, collect current VIX quotes and normalize them into the same 5-minute format
- **Cloud storage**: Push monthly JSON files to GCS for cheap, simple retrieval
- **HTTP endpoints**: Query by a timestamp or by a date range

---

## <a id="problem"></a>The Problem I Wanted to Solve

As a trader and developer, I needed reliable VIX data at high resolution for:
- **Options strategy analysis**: VIX levels affect IV and option pricing
- **Market sentiment tracking**: VIX spikes indicate fear, drops indicate complacency
- **Historical backtesting**: Test strategies against real historical volatility data
- **Real-time monitoring**: Track VIX during market hours without manual checks

**Existing solutions fell short:**
- **Yahoo Finance**: Only provides 60 days of intraday data at a time
- **Premium data vendors**: Expensive ($50-500/month) for retail traders
- **Free APIs**: Rate-limited, unreliable, or missing historical depth
- **Manual tracking**: Too time-consuming and error-prone

I wanted a solution that:
- ✅ Collects data automatically (no babysitting)
- ✅ Stores historical data indefinitely (not just 60 days)
- ✅ Blends historical + live data seamlessly
- ✅ Costs almost nothing to run (~$1-2/month)
- ✅ Provides simple HTTP APIs for queries

---

## <a id="vision"></a>The Vision: Automated VIX Pipeline

The core idea was simple: **build a lightweight pipeline that just works**.

No complex infrastructure. No expensive databases. No babysitting. Just:
1. Collect historical 5-minute VIX candles from Yahoo Finance
2. Collect live VIX quotes from Tastytrade during market hours
3. Normalize everything to the same OHLC format
4. Store monthly partitions in Google Cloud Storage
5. Query via simple HTTP functions

**Design principles:**
- **Keep it simple**: SQLite for local storage, JSON for cloud storage
- **Make it cheap**: GCS is ~$0.02/GB/month, Cloud Functions are nearly free
- **Make it reliable**: Daily collectors handle Yahoo's 60-day limit automatically
- **Make it queryable**: HTTP endpoints for timestamp and range queries

---

## <a id="architecture"></a>How The Pieces Fit Together

OptionMantra follows a simple collection → storage → query architecture:

### 1. **Historical 5-Minute Data** (Yahoo Finance)

**The Challenge**: Yahoo Finance limits intraday data to 60 days per request.

**The Solution**: Run a daily collector that:
- Fetches the latest 60 days of 5-minute VIX candles
- Merges results into a local SQLite database
- Deduplicates by timestamp to avoid conflicts
- Over time, builds a series much longer than 60 days

**SQLite Schema:**
```sql
CREATE TABLE vix_5min (
  datetime TEXT PRIMARY KEY,
  open REAL,
  high REAL,
  low REAL,
  close REAL,
  volume INTEGER
);
```

**Scheduling**: Runs daily via Cloud Scheduler (outside market hours)

### 2. **Live VIX Collection** (Tastytrade)

**Two collectors for different needs:**

**5-Minute Collector** (mirrors historical format):
- Polls Tastytrade API during market hours
- Normalizes live quotes to OHLC format:
  - `open`, `high`, `low`, `close` inferred from bid/ask/last/mark
  - `volume` set to 0 (not available in live quotes)
- Stores in same SQLite table as historical data
- Uploads to GCS monthly partitions

**1-Minute Collector** (richer data):
- Captures detailed metadata:
  - Daily high/low
  - Change percentage
  - Bid/ask spread
  - Last trade details
  - Mark price
- Stored in separate monthly partitions (`YYYY/MM_livemin.json`)
- Useful for detailed analysis and debugging

**Market Hours Check**:
```python
def is_market_hours():
    """Check if current time is during market hours (9:30 AM - 4:00 PM ET)"""
    now = datetime.now(eastern)
    return (now.weekday() < 5 and  # Monday-Friday
            time(9, 30) <= now.time() <= time(16, 0))
```

### 3. **Cloud Storage** (Google Cloud Storage)

**Partitioning Strategy** (keeps costs low and queries fast):

```
gs://vix-data-bucket/
├── 2024/
│   ├── 01.json          # Historical 5-min data (Jan 2024)
│   ├── 01_live.json     # Live 5-min data (Jan 2024)
│   ├── 02.json          # Historical 5-min data (Feb 2024)
│   ├── 02_live.json     # Live 5-min data (Feb 2024)
│   └── ...
├── 2025/
│   ├── 01.json
│   ├── 01_live.json
│   └── ...
└── live_data/
    └── 2025/
        └── 01_livemin.json  # 1-minute granular live data
```

**Benefits of monthly partitioning:**
- **Fast queries**: Load only relevant months
- **Low cost**: GCS is ~$0.02/GB/month (entire dataset < 1GB = $0.02/month)
- **Easy maintenance**: Delete old files if needed
- **Simple backup**: Copy entire bucket with `gsutil`

### 4. **Serving Data from GCS** (HTTP Endpoints)

**Two Cloud Functions for querying:**

**a) Nearest Timestamp Query**:
```python
GET /vix/nearest?timestamp=2024-03-15T10:30:00

Response:
[
  {
    "datetime": "2024-03-15 10:25:00",
    "open": 14.25,
    "high": 14.35,
    "low": 14.20,
    "close": 14.30,
    "volume": 0
  },
  {
    "datetime": "2024-03-15 10:30:00",
    "open": 14.30,
    "high": 14.40,
    "low": 14.28,
    "close": 14.38,
    "volume": 0
  }
]
```

**b) Date Range Query**:
```python
GET /vix/range?start=2024-03-15T09:30:00&end=2024-03-15T16:00:00

Response: [...all 5-min records in range...]
```

### 5. **Bulk Upload for Historical CSVs**

When you already have historical CSV data:
```python
python upload_csv_to_gcs.py --input vix_historical.csv
```

Script automatically:
- Parses CSV into records
- Groups by year/month
- Uploads to correct partition in GCS
- Deduplicates existing data

---

## <a id="data-shape"></a>The Data Shape: 5-Minute OHLC

Everything is normalized to this structure so historical and live data can be merged cleanly:

```json
{
  "datetime": "YYYY-MM-DD HH:MM:SS",
  "open": 14.25,
  "high": 14.35,
  "low": 14.20,
  "close": 14.30,
  "volume": 0
}
```

**For live quotes**, where we only have bid/ask/last/mark:
- `open` = previous `close` or `mark`
- `high` = max(bid, ask, last, mark)
- `low` = min(bid, ask, last, mark)
- `close` = last` or `mark`
- `volume` = 0 (not available)

This keeps the series consistent and queryable.

---

## <a id="done"></a>What Is Already Done (Highlights)

✅ **Market-hours checks**: Live collectors stay quiet outside 9:30 AM - 4:00 PM ET

✅ **Monthly partitioning**: Clean time series storage in GCS

✅ **Deduplication**: No duplicate timestamps in SQLite or GCS

✅ **Cloud Scheduler wiring**: Fully automated collection (set it and forget it)

✅ **Two retrieval APIs**: Nearest timestamp + date range queries

✅ **Exploration tools**: Inspect full Tastytrade payload for debugging

✅ **Historical CSV bulk upload**: Import existing data easily

✅ **1-minute granular data**: Richer live data for detailed analysis

✅ **Cost optimization**: ~$1-2/month total (GCS storage + Cloud Functions)

---

## <a id="tech-stack"></a>The Tech Stack

- **Python 3.11**: Main language for all scripts and functions
- **SQLite**: Local storage for historical and live data
- **Google Cloud Storage (GCS)**: Cloud storage for monthly JSON partitions
- **Google Cloud Functions**: HTTP endpoints for queries
- **Google Cloud Scheduler**: Automated daily/intraday collection
- **Yahoo Finance API** (yfinance): Historical 5-minute candles
- **Tastytrade API**: Live VIX quotes during market hours
- **pandas**: Data manipulation and CSV handling
- **pytz**: Timezone handling (Eastern Time for market hours)

**Infrastructure:**
- **Cost**: ~$1-2/month (mostly GCS storage)
- **Deployment**: Cloud Functions (serverless, auto-scaling)
- **Scheduling**: Cloud Scheduler (cron-like)
- **Authentication**: Google Cloud service accounts

---

## <a id="performance"></a>Performance & Cost

### Performance Metrics

| Metric | Value |
|--------|-------|
| **Historical Data Fetch** | ~5 seconds for 60 days |
| **Live Quote Fetch** | ~1 second per poll |
| **GCS Upload** | ~2 seconds per month partition |
| **Query (Nearest)** | ~0.5 seconds |
| **Query (Range, 1 day)** | ~1 second |
| **Query (Range, 1 month)** | ~3 seconds |

### Cost Breakdown

| Service | Usage | Monthly Cost |
|---------|-------|--------------|
| **GCS Storage** | ~500MB data | ~$0.01 |
| **Cloud Functions** | ~10,000 invocations | ~$0.40 (free tier) |
| **Cloud Scheduler** | ~50 jobs/month | ~$0.10 (free tier) |
| **Egress (queries)** | ~1GB/month | ~$0.12 |
| **Total** | | **~$1-2/month** |

**vs. Premium Data Vendors**: $50-500/month = **96-99% cost savings**

---

## <a id="learnings"></a>The Learnings

### What Worked Well

**✅ SQLite for local storage**: Simple, fast, no setup required. Perfect for single-user data collection.

**✅ Monthly JSON partitions**: Cheaper than BigQuery, simpler than databases, fast for time-series queries.

**✅ Cloud Scheduler automation**: Set it once, runs forever. No cron jobs on VPS to maintain.

**✅ Tastytrade API**: Free, reliable, good documentation. Much better than paid alternatives.

**✅ Keep it simple**: No Kafka, no Airflow, no Kubernetes. Just Python scripts + Cloud Functions.

### The Challenges

**⚠️ Yahoo Finance 60-day limit**: Required daily collector to build longer history. Solved by merging into SQLite.

**⚠️ Live data normalization**: Had to infer OHLC from bid/ask/last/mark. Not perfect but good enough.

**⚠️ Timezone handling**: Market hours are ET, servers are UTC. Required careful pytz usage.

**⚠️ Deduplication logic**: Had to handle overlapping data from multiple sources. Solved with primary keys.

### Key Insights

1. **Start simple, scale later**: Don't over-engineer. SQLite + GCS is enough for 99% of use cases.

2. **Partition by time**: Monthly partitions make queries fast and costs predictable.

3. **Automate everything**: Cloud Scheduler is your friend. No manual intervention needed.

4. **Free APIs exist**: Tastytrade provides excellent free APIs for retail traders.

5. **Cost optimization matters**: $1/month vs $500/month is the difference between a hobby project and an expensive subscription.

---

## <a id="roadmap"></a>Where This Could Go Next

If I keep evolving this, these are the natural next steps:

### Phase 2: Data Quality & Merging
- Merge live JSON into monthly historical files on a schedule
- Validate data integrity (no gaps, no duplicates)
- Backfill missing periods automatically
- Add data quality metrics dashboard

### Phase 3: Visualization & API
- Build a small dashboard to visualize latest VIX moves
- Add RESTful API layer with authentication
- Provide CSV/JSON export endpoints
- Historical chart rendering (Plotly/Matplotlib)

### Phase 4: Analysis & Alerts
- VIX spike detection (>10% move in 5 min)
- Email/SMS alerts for threshold crossings
- Historical correlation analysis (VIX vs SPX)
- Options strategy signals based on VIX levels

### Phase 5: Multi-Symbol Support
- Expand beyond VIX to other volatility indices (VIX9D, VVIX)
- SPX/SPY data collection for correlation
- Individual stock IV tracking
- Crypto volatility indices

---

## <a id="final-thoughts"></a>Final Thoughts: Build What You Need

OptionMantra represents a philosophy: **solve your own problems with simple, reliable tools**.

You don't need expensive data vendors. You don't need complex infrastructure. You don't need to babysit data collection scripts.

The solution? Use free APIs. Store data cheaply in cloud storage. Automate with serverless functions. Keep it simple.

This pipeline runs quietly in the background, collecting VIX data day after day, month after month. It costs less than a cup of coffee per month. It provides data whenever I need it, however I need it.

And it proves that with the right tools and a pragmatic approach, you can build professional-grade data infrastructure for pennies.

---

## Try It Yourself

The architecture is simple. The tools are free (or dirt cheap). The code is straightforward Python.

If you're tracking VIX, options volatility, or any time-series data, this approach can work for you:

1. **Collect data** from free APIs (Yahoo Finance, Tastytrade, etc.)
2. **Store locally** in SQLite for quick access
3. **Upload to GCS** in monthly partitions for long-term storage
4. **Query via HTTP** with Cloud Functions
5. **Automate with** Cloud Scheduler

No vendor lock-in. No expensive subscriptions. Just your data, your way.

---

**Tech Stack**: Python • SQLite • Google Cloud Storage • Cloud Functions • Yahoo Finance • Tastytrade API  
**Cost**: ~$1-2/month (vs $50-500/month for premium vendors)  
**Data**: 5-minute VIX resolution, indefinite historical retention  
**Automation**: Fully automated with Cloud Scheduler  

**Status**: ✅ Running in production  
**Blog**: Madhudream.dev/optionmantra  
**Code**: Available on request  

---

## <a id="screenshots"></a>Screenshots Gallery

### Screenshot 1: SQLite Database View
![SQLite VIX Data](/optionmantra/image1.png)
*Local SQLite database with 5-minute VIX OHLC data*

### Screenshot 2: GCS Storage Structure
![GCS Monthly Partitions](/optionmantra/image2.png)
*Google Cloud Storage showing monthly JSON partitions (2024/01.json, 02.json, etc.)*

### Screenshot 3: Live Data Collection Log
![Live Collection Monitor](/optionmantra/image3.png)
*Real-time logs showing VIX quote collection during market hours*

### Screenshot 4: Query API Response
![HTTP Query Results](/optionmantra/image4.png)
*Sample response from nearest timestamp query endpoint*

---

_Built with Python and Google Cloud Platform. Automated data collection with Cloud Scheduler. Cost-optimized architecture for retail traders._
