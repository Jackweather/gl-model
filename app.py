from __future__ import annotations

import gzip
import hashlib
import json
import math
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse, parse_qs, urlencode

import numpy as np
# `pygrib` is imported lazily inside `create_dataset` so the app can run
# when prebuilt cache files exist even if `pygrib` isn't installed.
import requests  # type: ignore

# Import `requests` lazily/optionally to avoid crashing if the user's
# environment has networking/cert packages broken. If import fails,
# `requests` will be `None` and `RequestsException` falls back to
# the built-in `Exception` so handlers still work.
try:
    import requests  # type: ignore
    RequestsException = requests.RequestException
except Exception:
    requests = None  # type: ignore
    RequestsException = Exception
from flask import Flask, Response, jsonify, request, send_from_directory
import threading
import traceback


ROOT = Path(__file__).resolve().parent
CACHE_DIR = ROOT / ".cache"
SOURCE_DIR = CACHE_DIR / "sources"
DATASET_DIR = CACHE_DIR / "datasets"
DEFAULT_MAPBOX_TOKEN = "pk.eyJ1Ijoid2VhdGhlcmphY2sxODkiLCJhIjoiY21tYzN0MHVrMDI4djJxcHdzNXdpOTQ2MyJ9.IM4BBEnM5tNLI2SnEyl3uw"
MERCATOR_MAX_LAT = 85.05112878
MAX_RENDER_PIXELS = 4_000_000
CACHE_TTL_SECONDS = 300
CACHE_FORMAT_VERSION = "hrrr-products-v1"
CACHE_TTL_SECONDS = 30
HISTORY_LIMIT = 65
MM_TO_INCHES = 1.0 / 25.4
QPE_INCH_PALETTE = {
    "kind": "qpe",
    "label": "in",
    "values": [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0],
    "colors": [
        "#f7fbff",
        "#deebf7",
        "#c6dbef",
        "#9ecae1",
        "#6baed6",
        "#4292c6",
        "#2171b5",
        "#08519c",
        "#ffffb2",
        "#fecc5c",
        "#fd8d3c",
        "#e31a1c",
    ],
}
LIGHTNING_PALETTE = {
    "kind": "lightning",
    "label": "Lightning",
    "values": [0.0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0],
    "colors": [
        "#140b34",
        "#2a1d72",
        "#1f4db8",
        "#158ee8",
        "#11c5f5",
        "#46f0c6",
        "#8fff7a",
        "#f2ff5b",
        "#ffbf38",
        "#ff7b22",
        "#ff3d2e",
        "#fff3f0",
    ],
}
LIGHTNING_PROBABILITY_PALETTE = {
    "kind": "lightning",
    "label": "%",
    "values": [0.0, 5.0, 10.0, 15.0, 20.0, 30.0, 40.0, 50.0, 60.0, 75.0, 90.0, 100.0],
    "colors": LIGHTNING_PALETTE["colors"].copy(),
}
LIGHTNING_DENSITY_PALETTE = {
    "kind": "lightning",
    "label": "density",
    "values": [0.0, 0.1, 0.2, 0.35, 0.5, 0.7, 0.9, 1.1, 1.3, 1.5, 1.75, 2.0],
    "colors": LIGHTNING_PALETTE["colors"].copy(),
}
TEMPERATURE_PALETTE = {
    "kind": "temperature",
    "label": "F",
    "values": [0.0, 10.0, 20.0, 32.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 100.0, 110.0],
    "colors": [
        "#3a1c71",
        "#2155c5",
        "#2f86ff",
        "#69c6ff",
        "#b7f3ff",
        "#f4f7d2",
        "#ffe08a",
        "#ffb34d",
        "#ff7b3a",
        "#ef4d3c",
        "#c92d4b",
        "#6b1d3a",
    ],
}
PRECIP_ID_PALETTE = {
    "kind": "precip_id",
    "label": "Precip ID",
    "discrete": True,
    "values": [-3.0, -1.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
    "labels": ["-3", "-1", "1", "2", "3", "4", "5", "6"],
    "colors": [
        "#1f2937",
        "#64748b",
        "#22c55e",
        "#38bdf8",
        "#facc15",
        "#fb7185",
        "#a78bfa",
        "#f97316",
    ],
}

# Simplified product config: only HRRR PRATE is used now.
PRODUCT_CONFIGS: dict[str, dict[str, Any]] = {
    "prate": {
        "id": "prate",
        "label": "GFS PRATE",
        "legendTitle": "PRATE",
        "sourceUrl": "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl?dir=%2Fgfs.20260618%2F12%2Fatmos&file=gfs.t12z.pgrb2.0p25.f000&var_PRATE=on&lev_surface=on",
        "historyPrefix": "filter_gfs_0p25.pl",
        "messageTerms": ["prate"],
        "minimumValue": 0.0,
        # GFS PRATE native units are kg m**-2 s**-1 (mm/s). Convert to inches/hour
        # for display: mm/s -> mm/hr (x3600) -> inches/hr (/25.4)
        "valueScale": 3600.0 / 25.4,
        "units": "in/hr",
        "unitsFallback": "in/hr",
        "palette": dict(QPE_INCH_PALETTE.copy(), **{
            "kind": "reflectivity",
            "colors": [
                "#ADD8E6",  # light sky blue
                "#00BFB3",  # turquoise
                "#008000",  # green
                "#FFD700",  # gold
                "#FFA500",  # orange
                "#FF6961",  # light red
                "#DC143C",  # deep red
                "#A020F0",  # magenta
                "#C65FE0",  # violet
                "#EE82EE",  # pink
                "#FADFAF",  # warm highlight
                "#FFFFFF",  # white
            ],
        }),
    },
}
DEFAULT_PRODUCT_ID = "prate"
# Add 2-meter temperature product (convert Kelvin -> Fahrenheit)
PRODUCT_CONFIGS["tmp2m"] = {
    "id": "tmp2m",
    "label": "GFS TMP 2m",
    "legendTitle": "TMP",
    "sourceUrl": "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl?dir=%2Fgfs.20260622%2F06%2Fatmos&file=gfs.t06z.pgrb2.0p25.f000&var_TMP=on&lev_2_m_above_ground=on",
    "historyPrefix": "filter_gfs_0p25.pl",
    "messageTerms": ["tmp", "temperature"],
    # allow very low values (don't clip realistic cold temps)
    "minimumValue": -9999.0,
    # Convert Kelvin -> Fahrenheit: F = K*1.8 - 459.67
    "valueScale": 1.8,
    "valueOffset": -459.67,
    "units": "F",
    "unitsFallback": "F",
    "palette": {
        "kind": "temperature",
        "label": "F",
        "values": [-40.0, -20.0, 0.0, 20.0, 32.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 100.0],
        "colors": [
            "#08306B",
            "#08519C",
            "#2171B5",
            "#6BAED6",
            "#D1E5F0",
            "#F7F7F7",
            "#FDDBC7",
            "#FDAE6B",
            "#F16913",
            "#D7301F",
            "#A50026",
            "#7F0000",
        ],
    },
}
def _make_dynamic_default_source_url(sample_url: str) -> str:
    """Given a sample NOMADS CGI URL, replace the embedded run date/cycle
    with the most-recent (past) cycle for the current UTC time. Falls back
    to the sample URL on error.
    """
    try:
        parsed = urlparse(sample_url)
        qs = parse_qs(parsed.query)

        # Choose the most-recent 6-hour cycle by using UTC now minus 6 hours
        # (matches the approach in the user's script: use the nearest past cycle)
        now = time.gmtime(time.time() - 6 * 3600)
        datestr = time.strftime("%Y%m%d", now)
        chosen_cycle = (now.tm_hour // 6) * 6
        cycle_str = f"{int(chosen_cycle):02d}"

        if "dir" in qs:
            qs["dir"] = [f"/gfs.{datestr}/{cycle_str}/atmos"]

        if "file" in qs:
            file_param = qs.get("file", [None])[0]
            if file_param:
                file_param = re.sub(r"t\d{1,2}z", f"t{cycle_str}z", file_param)
                file_param = re.sub(r"f\d{3}", "f000", file_param)
                qs["file"] = [file_param]

        return f"{parsed.scheme}://{parsed.netloc}{parsed.path}?{urlencode(qs, doseq=True)}"
    except Exception:
        return sample_url


DEFAULT_SOURCE_URL = _make_dynamic_default_source_url(PRODUCT_CONFIGS[DEFAULT_PRODUCT_ID]["sourceUrl"])


app = Flask(__name__, static_folder="static", static_url_path="/static")


def product_config_for_source(source_url: str) -> dict[str, Any]:
    parsed = urlparse(source_url)
    filename = Path(parsed.path).name

    # If the URL is a CGI filter endpoint, prefer selecting product by
    # the `var_*` query parameters (e.g. var_TMP=on, var_PRATE=on).
    qs = parse_qs(parsed.query)
    if filename.endswith("filter_gfs_0p25.pl") or "filter_gfs" in Path(parsed.path).name:
        # look for var_<NAME> keys and map to products by messageTerms
        for key in qs.keys():
            if not key.startswith("var_"):
                continue
            varname = key[4:].lower()
            for config in PRODUCT_CONFIGS.values():
                for term in config.get("messageTerms", []):
                    # match common token forms (tmp, prate, temperature)
                    if varname == term.lower() or varname.startswith(term.lower()):
                        return config

    # Fallback: match by historyPrefix in filename
    for config in PRODUCT_CONFIGS.values():
        if filename.startswith(config["historyPrefix"]):
            return config

    return PRODUCT_CONFIGS[DEFAULT_PRODUCT_ID]


def product_payloads() -> list[dict[str, str]]:
    payloads: list[dict[str, str]] = []
    for config in PRODUCT_CONFIGS.values():
        try:
            dynamic_url = _make_dynamic_default_source_url(config["sourceUrl"])
        except Exception:
            dynamic_url = config["sourceUrl"]

        payloads.append(
            {
                "id": config["id"],
                "label": config["label"],
                "legendTitle": config["legendTitle"],
                "sourceUrl": dynamic_url,
            }
        )

    return payloads


def ensure_cache_dirs() -> None:
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    DATASET_DIR.mkdir(parents=True, exist_ok=True)


def dataset_key(source_url: str) -> str:
    seed = f"{CACHE_FORMAT_VERSION}:{source_url}"
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()[:16]


def cached_paths(key: str) -> dict[str, Path]:
    return {
        "source": SOURCE_DIR / f"{key}.grib2",
        "meta": DATASET_DIR / f"{key}.json",
        "texture": DATASET_DIR / f"{key}.luma.gz",
    }


def is_nomads_url(source_url: str) -> bool:
    parsed = urlparse(source_url)
    return parsed.scheme in {"http", "https"} and parsed.netloc.endswith("ncep.noaa.gov")


def latest_is_alias(source_url: str) -> bool:
    return source_url.endswith(".latest.grib2.gz")


def source_directory_url(source_url: str) -> str:
    return source_url.rsplit("/", 1)[0] + "/"


def list_recent_sources(source_url: str, limit: int = HISTORY_LIMIT) -> list[dict[str, str]]:
    # Try to detect a recent run directory (date + cycle) and enumerate frames.
    # NOMADS dirs often look like /gfs.YYYYMMDD/HH/ or /gfs.YYYYMMDD/HH/atmos with files named ...fXXX
    try:
        filename = Path(urlparse(source_url).path).name
        # detect existing fNNN in filename
        m = re.search(r"f0*\d{1,3}", filename)
        if not m:
            return [{"label": "Latest", "sourceUrl": source_url, "kind": "latest"}]

        # isolate prefix/suffix around forecast hour token
        prefix = filename[: m.start()]
        suffix = filename[m.end():]


        # derive base dir and attempt to find most recent run date/cycle
        parsed = urlparse(source_url)
        base_dir = source_directory_url(source_url)

        # handle CGI filter endpoints (e.g. filter_gfs_0p25.pl) which encode run dir in the query
        is_cgi = parsed.path.endswith("filter_gfs_0p25.pl") or "filter_gfs" in Path(parsed.path).name
        import requests as _requests

        frames: list[dict[str, str]] = []

        # If CGI, parse query params to extract file template
        if is_cgi:
            qs = parse_qs(parsed.query)
            dir_param = qs.get("dir", [None])[0]
            file_param = qs.get("file", [None])[0]

            # find tNNz and fNNN in file_param
            t_match = re.search(r"t(\d{1,2})z", file_param or "")
            f_match = re.search(r"f(\d{3})", file_param or "")

            now = time.gmtime()
            current_hour = now.tm_hour
            # availability hours for cycles (UTC)
            availability = {0: 1, 6: 7, 12: 13, 18: 19}
            cycles = [18, 12, 6, 0]

            # Build candidate runs ordered by recency
            run_candidates = []
            for days_back in range(0, 3):
                dt = time.gmtime(time.time() - days_back * 86400)
                datestr = time.strftime("%Y%m%d", dt)
                if days_back == 0:
                    # include only cycles whose availability hour has passed for today
                    for c in cycles:
                        if current_hour >= availability.get(c, c):
                            run_candidates.append((datestr, f"{c:02d}"))
                else:
                    for c in cycles:
                        run_candidates.append((datestr, f"{c:02d}"))

            # probe each run candidate and enumerate frames
            for datestr, cycle in run_candidates:
                qs_copy = dict(qs)
                qs_copy["dir"] = [f"/gfs.{datestr}/{cycle}/atmos"]
                # update file param's t and f placeholders
                if file_param:
                    file_template = file_param
                    if t_match:
                        file_template = re.sub(r"t\d{1,2}z", f"t{int(cycle):02d}z", file_template)
                    if f_match:
                        # use f000 as a template placeholder
                        file_template = re.sub(r"f\d{3}", f"f000", file_template)
                    qs_copy["file"] = [file_template]

                candidate_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}?{urlencode(qs_copy, doseq=True)}"
                try:
                    resp = _requests.get(candidate_url, headers={"Range": "bytes=0-1", "User-Agent": "HRRR-Demo/1.0"}, stream=True, timeout=10)
                    if resp.status_code not in (200, 206):
                        continue
                except Exception:
                    continue

                # found a valid run; now enumerate forecast hours
                for fh in range(0, 385, 6):
                    qs_copy2 = dict(qs_copy)
                    file_for_fh = qs_copy["file"][0]
                    file_for_fh = re.sub(r"f000", f"f{fh:03d}", file_for_fh)
                    qs_copy2["file"] = [file_for_fh]
                    candidate_fh_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}?{urlencode(qs_copy2, doseq=True)}"
                    try:
                        resp2 = _requests.get(candidate_fh_url, headers={"Range": "bytes=0-1", "User-Agent": "HRRR-Demo/1.0"}, stream=True, timeout=10)
                        if resp2.status_code in (200, 206):
                            frames.append({"label": f"f{fh:03d}", "sourceUrl": candidate_fh_url, "kind": "frame"})
                    except Exception:
                        continue

                if frames:
                    break

        else:
            # Non-CGI path: probe directory-style URLs
            now = time.gmtime()
            current_hour = now.tm_hour
            # availability hours for cycles (UTC)
            availability = {0: 1, 6: 7, 12: 13, 18: 19}
            cycles = [18, 12, 6, 0]

            run_candidates = []
            for days_back in range(0, 3):
                dt = time.gmtime(time.time() - days_back * 86400)
                datestr = time.strftime("%Y%m%d", dt)
                if days_back == 0:
                    for c in cycles:
                        if current_hour >= availability.get(c, c):
                            run_candidates.append((datestr, f"{c:02d}"))
                else:
                    for c in cycles:
                        run_candidates.append((datestr, f"{c:02d}"))

            for datestr, cycle in run_candidates:
                host_base = f"{parsed.scheme}://{parsed.netloc}/"
                run_path = f"gfs.{datestr}/{cycle}/"
                candidate_file = urljoin(host_base, run_path + prefix + f"f000" + suffix)
                try:
                    resp = _requests.get(candidate_file, headers={"Range": "bytes=0-1", "User-Agent": "HRRR-Demo/1.0"}, stream=True, timeout=10)
                    if resp.status_code not in (200, 206):
                        continue
                except Exception:
                    continue

                # enumerate frames
                for fh in range(0, 385, 6):
                    fname = f"{prefix}f{fh:03d}{suffix}"
                    candidate = urljoin(host_base, run_path + fname)
                    try:
                        resp2 = _requests.get(candidate, headers={"Range": "bytes=0-1", "User-Agent": "HRRR-Demo/1.0"}, stream=True, timeout=10)
                        if resp2.status_code in (200, 206):
                            frames.append({"label": f"f{fh:03d}", "sourceUrl": candidate, "kind": "frame"})
                    except Exception:
                        continue

                if frames:
                    break

        if not frames:
            # If probing failed (HEAD blocked or files not discoverable), assume
            # the most-recent run is the current UTC date with the nearest past
            # 6-hour cycle and build f000..f384 URLs without probing. This makes
            # the frontend show today's run immediately and defers validation
            # until download time.
            now = time.gmtime()
            current_hour = now.tm_hour
            # availability hours for cycles (UTC)
            availability = {0: 1, 6: 7, 12: 13, 18: 19}
            cycles = [18, 12, 6, 0]
            chosen_cycle = None
            for c in cycles:
                if current_hour >= availability.get(c, c):
                    chosen_cycle = c
                    break

            # If probing fails, assume the most-recent run is the nearest past
            # 6-hour cycle (UTC now minus 6 hours). This mirrors the user's
            # script behavior and avoids selecting a future/unpublished cycle.
            dt_choose = time.gmtime(time.time() - 6 * 3600)
            datestr = time.strftime("%Y%m%d", dt_choose)
            chosen_cycle = (dt_choose.tm_hour // 6) * 6
            cycle_str = f"{int(chosen_cycle):02d}"
            assumed: list[dict[str, str]] = []
            if is_cgi:
                qs = parse_qs(parsed.query)
                file_param = qs.get("file", [None])[0] or f"{prefix}f000{suffix}"
                # normalize file template to f000 placeholder
                file_template = re.sub(r"f\d{3}", "f000", file_param)
                for fh in range(0, 385, 6):
                    qs2 = dict(qs)
                    qs2["dir"] = [f"/gfs.{datestr}/{cycle_str}/atmos"]
                    qs2["file"] = [re.sub(r"f000", f"f{fh:03d}", file_template)]
                    candidate = f"{parsed.scheme}://{parsed.netloc}{parsed.path}?{urlencode(qs2, doseq=True)}"
                    assumed.append({"label": f"f{fh:03d}", "sourceUrl": candidate, "kind": "frame"})
            else:
                host_base = f"{parsed.scheme}://{parsed.netloc}/"
                run_path = f"gfs.{datestr}/{cycle_str}/"
                for fh in range(0, 385, 6):
                    fname = f"{prefix}f{fh:03d}{suffix}"
                    candidate = urljoin(host_base, run_path + fname)
                    assumed.append({"label": f"f{fh:03d}", "sourceUrl": candidate, "kind": "frame"})

            if assumed:
                return assumed

            return [{"label": "Latest", "sourceUrl": source_url, "kind": "latest"}]

        return frames
    except Exception:
        return [{"label": "Latest", "sourceUrl": source_url, "kind": "latest"}]


def list_recent_runs(source_url: str, limit: int = 8) -> list[dict[str, str]]:
    """Return a list of recent runs (date + cycle) for the given NOMADS sample URL.
    Each run entry includes a sample f000 `sourceUrl` to use as the seed for frames.
    """
    try:
        parsed = urlparse(source_url)
        filename = Path(parsed.path).name
        m = re.search(r"f0*\d{1,3}", filename)
        is_cgi = parsed.path.endswith("filter_gfs_0p25.pl") or "filter_gfs" in Path(parsed.path).name

        # If we can't detect a filename pattern and it's not CGI, nothing to do
        if not m and not is_cgi:
            return []

        # derive prefix/suffix for non-CGI style paths
        prefix = ""
        suffix = ""
        if m:
            prefix = filename[: m.start()]
            suffix = filename[m.end():]

        runs: list[dict[str, str]] = []
        now = time.gmtime()
        current_hour = now.tm_hour
        availability = {0: 1, 6: 7, 12: 13, 18: 19}
        cycles = [18, 12, 6, 0]

        # Build candidate runs for today and previous days
        run_candidates = []
        for days_back in range(0, 4):
            dt = time.gmtime(time.time() - days_back * 86400)
            datestr = time.strftime("%Y%m%d", dt)
            # always include the standard 6-hour cycles so user can pick them
            for c in cycles:
                run_candidates.append((datestr, f"{c:02d}"))

        import requests as _requests
        for datestr, cycle in run_candidates:
            if is_cgi:
                qs = parse_qs(parsed.query)
                qs2 = dict(qs)
                qs2["dir"] = [f"/gfs.{datestr}/{cycle}/atmos"]
                file_param = qs.get("file", [None])[0]
                if file_param:
                    # normalize forecast hour to f000 and align the analysis
                    # cycle token (tNNz) with the candidate `cycle` so we don't
                    # request mismatched t/cycle combinations (which produce 404s)
                    file_template = re.sub(r"f\d{3}", "f000", file_param)
                    file_template = re.sub(r"t\d{1,2}z", f"t{int(cycle):02d}z", file_template)
                    qs2["file"] = [file_template]
                candidate = f"{parsed.scheme}://{parsed.netloc}{parsed.path}?{urlencode(qs2, doseq=True)}"
            else:
                host_base = f"{parsed.scheme}://{parsed.netloc}/"
                run_path = f"gfs.{datestr}/{cycle}/"
                candidate = urljoin(host_base, run_path + prefix + f"f000" + suffix)

            available = False
            try:
                # probe that f000 exists for this run
                resp = _requests.get(candidate, headers={"Range": "bytes=0-1", "User-Agent": "HRRR-Demo/1.0"}, stream=True, timeout=8)
                if resp.status_code in (200, 206):
                    available = True
            except Exception:
                available = False

            runs.append({
                "label": f"{datestr}/{cycle}",
                "sourceUrl": candidate,
                "date": datestr,
                "cycle": cycle,
                "available": available,
            })

            if len(runs) >= limit:
                break

        return runs
    except Exception:
        return []


@app.get("/api/reflectivity/runs")
def runs_endpoint() -> Any:
    source_url = request.args.get("source", DEFAULT_SOURCE_URL)
    try:
        runs = list_recent_runs(source_url)
        return jsonify({"runs": runs})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


def source_cache_is_fresh(source_url: str, source_path: Path) -> bool:
    if not source_path.exists() or source_path.stat().st_size == 0:
        return False

    if not latest_is_alias(source_url):
        return True

    return (time.time() - source_path.stat().st_mtime) <= CACHE_TTL_SECONDS


def download_grib(source_url: str, key: str) -> Path:
    output_path = cached_paths(key)["source"]
    if source_cache_is_fresh(source_url, output_path):
        return output_path

    suffix = ".grib2"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix, dir=output_path.parent) as handle:
        temp_path = Path(handle.name)

    try:
        import requests as _requests  # local import to avoid top-level dependency failures
    except Exception as exc:
        raise RuntimeError("requests is required to download GRIB2 sources") from exc

    with _requests.get(source_url, stream=True, timeout=120, headers={"User-Agent": "HRRR-Demo/1.0"}) as response:
        response.raise_for_status()
        response.raw.decode_content = False
        with temp_path.open("wb") as handle:
            if source_url.endswith(".gz"):
                with gzip.GzipFile(fileobj=response.raw) as gz_stream:
                    shutil.copyfileobj(gz_stream, handle, length=1024 * 1024)
            else:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        handle.write(chunk)

    temp_path.replace(output_path)
    return output_path


def pick_product_message(grib_file: Any, source_url: str) -> Any:
    product_config = product_config_for_source(source_url)
    message_terms = product_config["messageTerms"]
    messages = list(grib_file)

    if len(messages) == 1:
        return messages[0]

    for message in messages:
        fields = [
            getattr(message, "shortName", ""),
            getattr(message, "name", ""),
            getattr(message, "parameterName", ""),
        ]
        if any(term in str(field).lower() for field in fields for term in message_terms):
            return message

    return messages[0]


def normalize_longitudes(lon_row: np.ndarray, values: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    shifted = ((lon_row + 180.0) % 360.0) - 180.0
    order = np.argsort(shifted)
    return shifted[order], values[:, order]


def compute_edge_bounds(lon_row: np.ndarray, lat_col: np.ndarray) -> tuple[float, float, float, float]:
    if lon_row.size < 2 or lat_col.size < 2:
        raise ValueError("Need at least two grid points to compute raster bounds.")

    lon_step = float(np.median(np.diff(lon_row)))
    lat_step = float(np.median(np.abs(np.diff(lat_col))))
    half_lon = lon_step / 2.0
    half_lat = lat_step / 2.0

    west = float(lon_row[0] - half_lon)
    east = float(lon_row[-1] + half_lon)
    south = float(lat_col[-1] - half_lat)
    north = float(lat_col[0] + half_lat)

    if east - west >= 359.5:
        west = -180.0
        east = 180.0

    return west, east, south, north


def downsample_grid(
    lon_row: np.ndarray,
    lat_col: np.ndarray,
    values: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    total_pixels = int(values.shape[0] * values.shape[1])
    if total_pixels <= MAX_RENDER_PIXELS:
        return lon_row, lat_col, values, 1

    stride = int(math.ceil(math.sqrt(total_pixels / MAX_RENDER_PIXELS)))
    return lon_row[::stride], lat_col[::stride], values[::stride, ::stride], stride


def sanitize_values(values: np.ndarray, source_url: str) -> np.ndarray:
    product_config = product_config_for_source(source_url)
    cleaned = values.astype(np.float32, copy=True)
    cleaned[~np.isfinite(cleaned)] = np.nan
    cleaned[cleaned < float(product_config["minimumValue"])] = np.nan
    return cleaned


def scale_values_for_product(values: np.ndarray, source_url: str) -> np.ndarray:
    product_config = product_config_for_source(source_url)
    value_scale = float(product_config.get("valueScale", 1.0))
    value_offset = float(product_config.get("valueOffset", 0.0))
    if value_scale == 1.0 and value_offset == 0.0:
        return values

    transformed = values.astype(np.float32, copy=False) * value_scale
    if value_offset != 0.0:
        transformed = transformed + value_offset

    return transformed


def build_texture(values: np.ndarray, source_url: str) -> tuple[bytes, dict[str, float]]:
    valid_mask = np.isfinite(values)
    if not np.any(valid_mask):
        raise ValueError("The reflectivity field does not contain any finite values.")

    product_config = product_config_for_source(source_url)
    palette_values = [float(value) for value in product_config["palette"].get("values", [])]
    finite_values = values[valid_mask]
    data_min = float(np.min(finite_values))
    data_max = float(np.max(finite_values))
    if data_max <= data_min:
        data_max = data_min + 1e-6

    if palette_values:
        display_min = palette_values[0]
        display_max = palette_values[-1]
    else:
        display_min = float(np.percentile(finite_values, 1.0))
        display_max = float(np.percentile(finite_values, 99.5))
        if display_max <= display_min:
            display_min = data_min
            display_max = data_max

    scale = 254.0 / (data_max - data_min)
    quantized = np.zeros(values.shape, dtype=np.uint8)
    quantized[valid_mask] = np.clip(
        np.rint((values[valid_mask] - data_min) * scale) + 1.0,
        1,
        255,
    ).astype(np.uint8)

    packed = np.flipud(quantized).tobytes()
    compressed = gzip.compress(packed, compresslevel=6, mtime=0)
    stats = {
        "dataMin": data_min,
        "dataMax": data_max,
        "displayMin": display_min,
        "displayMax": display_max,
    }
    return compressed, stats


def cache_is_fresh(paths: dict[str, Path]) -> bool:
    if not paths["meta"].exists() or not paths["texture"].exists():
        return False

    newest_mtime = max(paths["meta"].stat().st_mtime, paths["texture"].stat().st_mtime)
    return (time.time() - newest_mtime) <= CACHE_TTL_SECONDS


def remove_dataset_files(source_url: str) -> None:
    paths = cached_paths(dataset_key(source_url))
    for path in paths.values():
        path.unlink(missing_ok=True)


def prune_dataset_cache(active_sources: list[str]) -> None:
    active_keys = {dataset_key(source_url) for source_url in active_sources}
    for source_path in SOURCE_DIR.glob("*.grib2"):
        key = source_path.stem
        if key in active_keys:
            continue

        source_path.unlink(missing_ok=True)
        (DATASET_DIR / f"{key}.json").unlink(missing_ok=True)
        (DATASET_DIR / f"{key}.luma.gz").unlink(missing_ok=True)


def create_dataset(source_url: str, key: str) -> dict[str, Any]:
    paths = cached_paths(key)
    source_path = download_grib(source_url, key)
    product_config = product_config_for_source(source_url)

    try:
        import pygrib  # imported lazily so server can run when cache exists
    except ModuleNotFoundError as exc:
        raise RuntimeError("pygrib is required to create datasets from GRIB2 sources") from exc

    with pygrib.open(str(source_path)) as grib_file:
        message = pick_product_message(grib_file, source_url)
        values = message.values.astype(np.float32)
        latitudes, longitudes = message.latlons()

    lon_row, values = normalize_longitudes(longitudes[0, :], values)
    lat_col = latitudes[:, 0]
    if lat_col[0] < lat_col[-1]:
        lat_col = lat_col[::-1]
        values = np.flipud(values)

    lon_row, lat_col, values, stride = downsample_grid(lon_row, lat_col, values)
    values = scale_values_for_product(values, source_url)
    values = sanitize_values(values, source_url)
    texture_bytes, stats = build_texture(values, source_url)

    west, east, south, north = compute_edge_bounds(lon_row, lat_col)

    metadata = {
        "datasetId": key,
        "productId": product_config["id"],
        "productLabel": product_config["label"],
        "sourceUrl": source_url,
        "field": getattr(message, "name", None) if getattr(message, "name", None) not in {None, "unknown"} else product_config["label"],
        "level": getattr(message, "typeOfLevel", None) if getattr(message, "typeOfLevel", None) not in {None, "unknown"} else "heightAboveSea",
        "units": product_config.get("units") or (
            getattr(message, "units", None) if getattr(message, "units", None) not in {None, "unknown"} else product_config["unitsFallback"]
        ),
        "analysisTime": getattr(message, "analDate", None).isoformat() if getattr(message, "analDate", None) else None,
        "validTime": getattr(message, "validDate", None).isoformat() if getattr(message, "validDate", None) else None,
        "width": int(values.shape[1]),
        "height": int(values.shape[0]),
        "sourceWidth": int(longitudes.shape[1]),
        "sourceHeight": int(latitudes.shape[0]),
        "downsampleStride": stride,
        "bounds": {
            "west": west,
            "east": east,
            "south": max(south, -90.0),
            "north": min(north, 90.0),
        },
        "mercatorBounds": {
            "west": west,
            "east": east,
            "south": max(south, -MERCATOR_MAX_LAT),
            "north": min(north, MERCATOR_MAX_LAT),
        },
        "encoding": {
            "textureFormat": "luminance8",
            "packing": "0=no-data, 1..255=quantized data",
            "compression": "gzip",
            "valueRange": stats,
        },
        "palette": product_config["palette"],
        "textureUrl": f"/api/reflectivity/{key}.bin",
    }

    paths["meta"].write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    paths["texture"].write_bytes(texture_bytes)
    return metadata


def ensure_dataset(source_url: str) -> dict[str, Any]:
    ensure_cache_dirs()
    if not is_nomads_url(source_url):
        raise ValueError("Only NOMADS HTTP(S) URLs are allowed in this demo.")

    key = dataset_key(source_url)
    paths = cached_paths(key)
    if cache_is_fresh(paths):
        return json.loads(paths["meta"].read_text(encoding="utf-8"))

    return create_dataset(source_url, key)


def recent_history_payload(source_url: str) -> list[dict[str, str]]:
    history = list_recent_sources(source_url, limit=HISTORY_LIMIT)
    # If probing only returned a single 'Latest' placeholder or empty,
    # synthesize a full f000..f384 history so clients can populate sliders.
    try:
        if (not history) or (len(history) == 1 and history[0].get("kind") == "latest"):
            # attempt to build synthesized entries similar to the fallback in list_recent_sources
            parsed = urlparse(source_url)
            fallback_source = source_url
            synthesized = []
            # prefer using query `file=` if present to inject fNNN values
            qs = parse_qs(parsed.query)
            file_param = qs.get("file", [None])[0]
            for fh in range(0, 385, 6):
                if file_param:
                    try:
                        copy = dict(qs)
                        copy_file = re.sub(r"f\d{3}", f"f{fh:03d}", file_param)
                        copy["file"] = [copy_file]
                        candidate = f"{parsed.scheme}://{parsed.netloc}{parsed.path}?{urlencode(copy, doseq=True)}"
                    except Exception:
                        candidate = fallback_source
                else:
                    # try replacing fNNN in path if present
                    path = parsed.path
                    if re.search(r"f\d{3}", path):
                        candidate_path = re.sub(r"f\d{3}", f"f{fh:03d}", path)
                        candidate = f"{parsed.scheme}://{parsed.netloc}{candidate_path}"
                    else:
                        candidate = fallback_source

                synthesized.append({"label": f"f{fh:03d}", "sourceUrl": candidate, "kind": "frame"})

            prune_dataset_cache([entry["sourceUrl"] for entry in synthesized])
            return synthesized
    except Exception:
        pass

    prune_dataset_cache([entry["sourceUrl"] for entry in history])
    return history


@app.get("/")
def index() -> Any:
    return send_from_directory(app.static_folder, "index.html")


@app.get("/favicon.ico")
def favicon() -> Response:
    return Response(status=204)


@app.get("/api/config")
def app_config() -> Any:
    history = recent_history_payload(DEFAULT_SOURCE_URL)
    return jsonify(
        {
            "defaultMapboxToken": DEFAULT_MAPBOX_TOKEN,
            "defaultProductId": DEFAULT_PRODUCT_ID,
            "defaultSourceUrl": DEFAULT_SOURCE_URL,
            "history": history,
            "products": product_payloads(),
        }
    )


@app.get("/api/reflectivity")
def dataset_metadata() -> Any:
    source_url = request.args.get("source", DEFAULT_SOURCE_URL)
    try:
        metadata = ensure_dataset(source_url)
    except RequestsException as exc:
        tb = traceback.format_exc()
        return jsonify({"error": f"Failed to download GRIB2 source: {exc}", "trace": tb}), 502
    except RuntimeError as exc:
        # Commonly raised when pygrib is not installed; surface as 502 (bad upstream dependency)
        tb = traceback.format_exc()
        return jsonify({"error": str(exc), "trace": tb}), 502
    except Exception as exc:  # noqa: BLE001
        tb = traceback.format_exc()
        return jsonify({"error": str(exc), "trace": tb}), 400

    return jsonify(metadata)


@app.get("/api/reflectivity/history")
def dataset_history() -> Any:
    source_url = request.args.get("source", DEFAULT_SOURCE_URL)
    try:
        history = recent_history_payload(source_url)
    except RequestsException as exc:
        return jsonify({"error": f"Failed to fetch source directory listing: {exc}"}), 502
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 400

    return jsonify({"frames": history})


@app.get("/api/reflectivity/<dataset_id>.bin")
def dataset_texture(dataset_id: str) -> Response:
    texture_path = DATASET_DIR / f"{dataset_id}.luma.gz"
    if not texture_path.exists():
        return Response("Dataset texture not found.", status=404)

    payload = texture_path.read_bytes()
    return Response(
        payload,
        headers={
            "Content-Type": "application/octet-stream",
            "Content-Encoding": "gzip",
            "Cache-Control": "public, max-age=3600",
        },
    )


@app.get("/api/reflectivity/prefetch")
def dataset_prefetch() -> Any:
    """Start a background prefetch of the dataset for `source` and return immediately."""
    source_url = request.args.get("source")
    if not source_url:
        return jsonify({"error": "Missing source parameter"}), 400

    def _worker(url: str) -> None:
        try:
            ensure_dataset(url)
        except Exception:
            # Prefetch failures are non-fatal; they will be handled on demand.
            return

    thread = threading.Thread(target=_worker, args=(source_url,), daemon=True)
    thread.start()
    return jsonify({"status": "started"}), 202


if __name__ == "__main__":
    ensure_cache_dirs()
    # Debug: show computed default source and available products
    try:
        print("DEFAULT_SOURCE_URL=", DEFAULT_SOURCE_URL)
        print("PRODUCTS=", json.dumps(product_payloads(), indent=2))
    except Exception:
        pass
    app.run(debug=True, port=5000)