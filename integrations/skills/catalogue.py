from __future__ import annotations

import io
import shutil
import tarfile
from dataclasses import dataclass
from pathlib import Path

import httpx

CATALOGUE_REPO = "Prat011/awesome-llm-skills"
CATALOGUE_BRANCH = "master"
CATALOGUE_LICENSE = "Apache-2.0"
MAX_ARCHIVE_BYTES = 60 * 1024 * 1024


@dataclass
class FetchedCatalogue:
    repo: str
    commit: str | None
    root: Path
    license: str | None


async def fetch_github_archive(repo: str, branch: str, dest: Path, token: str | None = None) -> FetchedCatalogue:
    """Download a single tarball of a repository (no git clone) and extract it safely into dest."""
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "veylora-os"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, read=60.0), follow_redirects=True, headers=headers) as client:
        commit = None
        license_id = None
        try:
            c = await client.get(f"https://api.github.com/repos/{repo}/commits/{branch}")
            if c.status_code == 200:
                commit = c.json().get("sha")
            meta = await client.get(f"https://api.github.com/repos/{repo}")
            if meta.status_code == 200:
                license_id = ((meta.json().get("license") or {}).get("spdx_id"))
        except httpx.HTTPError:
            pass
        ref = commit or branch
        r = await client.get(f"https://codeload.github.com/{repo}/tar.gz/{ref}")
        r.raise_for_status()
        if len(r.content) > MAX_ARCHIVE_BYTES:
            raise ValueError("archive exceeds size limit")
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(r.content), mode="r:gz") as tar:
        members = [m for m in tar.getmembers() if m.isfile() or m.isdir()]
        tar.extractall(dest, members=members, filter="data")
    roots = [p for p in dest.iterdir() if p.is_dir()]
    root = roots[0] if len(roots) == 1 else dest
    return FetchedCatalogue(repo=repo, commit=commit, root=root, license=license_id)


def find_skill_dirs(root: Path, max_depth: int = 4) -> list[Path]:
    out = []
    for skill_md in sorted(root.rglob("SKILL.md")):
        rel_parts = skill_md.relative_to(root).parts
        if len(rel_parts) - 1 > max_depth or any(p.startswith(".") or p == "node_modules" for p in rel_parts):
            continue
        out.append(skill_md.parent)
    return out


CATEGORY_KEYWORDS = [
    ("Development & Code Tools", ("code", "mcp", "webapp", "testing", "artifacts", "changelog", "skill-creator", "template")),
    ("Document Processing", ("document", "docx", "pdf", "pptx", "xlsx")),
    ("Data & Analysis", ("data", "analy", "insight", "csv", "spreadsheet")),
    ("Creative & Media", ("art", "design", "canvas", "image", "video", "gif", "theme", "brand")),
    ("Business & Marketing", ("lead", "ads", "domain", "competitive", "marketing", "invoice")),
    ("Communication & Writing", ("comms", "writer", "content", "meeting")),
    ("Productivity & Organization", ("organizer", "notion", "file", "raffle")),
    ("Security & Systems", ("security", "detect", "forensic")),
]


def categorize(slug: str, description: str) -> str:
    text = f"{slug} {description}".lower()
    for category, words in CATEGORY_KEYWORDS:
        if any(w in slug for w in words):
            return category
    for category, words in CATEGORY_KEYWORDS:
        if any(w in text for w in words):
            return category
    return "General"
