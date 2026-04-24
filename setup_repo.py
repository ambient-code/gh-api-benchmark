#!/usr/bin/env python3
"""
Test Repo Setup
===============

Prepares a GitHub repo for benchmarking:
  1. Ensures repo exists (creates if needed via org API)
  2. Creates required labels
  3. Seeds main branch with initial commit + README
  4. Creates a minimal GitHub Actions workflow (for dispatch testing)
  5. Validates PAT permissions
"""

import json
import os
import sys
import base64
import httpx


def setup(token: str, org: str, repo: str):
    """Set up the benchmark test repository."""
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "acp-gh-benchmark-setup/1.0",
    }
    base = "https://api.github.com"

    print(f"Setting up {org}/{repo}...")

    # ── 1. Check/create repo ─────────────────────────────────────────
    resp = httpx.get(f"{base}/repos/{org}/{repo}", headers=headers)
    if resp.status_code == 404:
        print(f"  Creating repo {org}/{repo}...")
        resp = httpx.post(
            f"{base}/orgs/{org}/repos",
            headers=headers,
            json={
                "name": repo,
                "description": "GitHub API benchmark test repo for ACP",
                "private": True,
                "auto_init": True,
                "has_issues": True,
                "has_projects": False,
                "has_wiki": False,
            },
        )
        if resp.status_code not in (200, 201):
            print(f"  ✗ Failed to create repo: {resp.status_code} {resp.text[:200]}")

            # Try as personal repo
            print(f"  Trying as personal repo...")
            resp = httpx.post(
                f"{base}/user/repos",
                headers=headers,
                json={
                    "name": repo,
                    "description": "GitHub API benchmark test repo for ACP",
                    "private": True,
                    "auto_init": True,
                },
            )
            if resp.status_code not in (200, 201):
                print(f"  ✗ Failed: {resp.status_code} {resp.text[:200]}")
                sys.exit(1)

        print(f"  ✓ Repo created")
        # Wait for GitHub to initialize
        import time
        time.sleep(2)
    elif resp.status_code == 200:
        print(f"  ✓ Repo exists")
    else:
        print(f"  ✗ Unexpected: {resp.status_code}")
        sys.exit(1)

    # ── 2. Create labels ─────────────────────────────────────────────
    labels = [
        {"name": "amber-autofix", "color": "F9D03E", "description": "Amber auto-fix benchmark label"},
        {"name": "benchmark-complete", "color": "0E8A16", "description": "Benchmark cycle completed"},
    ]
    for label in labels:
        resp = httpx.post(
            f"{base}/repos/{org}/{repo}/labels",
            headers=headers,
            json=label,
        )
        if resp.status_code == 201:
            print(f"  ✓ Label '{label['name']}' created")
        elif resp.status_code == 422:
            print(f"  ✓ Label '{label['name']}' already exists")
        else:
            print(f"  ⚠ Label '{label['name']}': {resp.status_code}")

    # ── 3. Seed README on main ───────────────────────────────────────
    readme_content = base64.b64encode(
        b"# GitHub API Benchmark\n\nTest repo for ACP GitHub-as-state-machine benchmarking.\n"
    ).decode()
    resp = httpx.get(
        f"{base}/repos/{org}/{repo}/contents/README.md",
        headers=headers,
    )
    if resp.status_code == 404:
        resp = httpx.put(
            f"{base}/repos/{org}/{repo}/contents/README.md",
            headers=headers,
            json={
                "message": "Initial commit: benchmark setup",
                "content": readme_content,
            },
        )
        if resp.status_code in (200, 201):
            print(f"  ✓ README.md created")
    else:
        print(f"  ✓ README.md exists")

    # ── 4. Create workflow file for dispatch testing ──────────────────
    workflow_content = base64.b64encode(b"""name: amber-benchmark-handler
on:
  repository_dispatch:
    types: [amber-benchmark]

jobs:
  acknowledge:
    runs-on: ubuntu-latest
    steps:
      - name: Log benchmark trigger
        run: |
          echo "Benchmark cycle: ${{ github.event.client_payload.cycle_id }}"
          echo "Issue: ${{ github.event.client_payload.issue_number }}"
""").decode()

    resp = httpx.get(
        f"{base}/repos/{org}/{repo}/contents/.github/workflows/amber-benchmark.yml",
        headers=headers,
    )
    if resp.status_code == 404:
        resp = httpx.put(
            f"{base}/repos/{org}/{repo}/contents/.github/workflows/amber-benchmark.yml",
            headers=headers,
            json={
                "message": "Add benchmark workflow handler",
                "content": workflow_content,
            },
        )
        if resp.status_code in (200, 201):
            print(f"  ✓ Workflow file created")
        else:
            print(f"  ⚠ Workflow: {resp.status_code} {resp.text[:200]}")
    else:
        print(f"  ✓ Workflow file exists")

    # ── 5. Validate permissions ──────────────────────────────────────
    print(f"\n  Checking permissions...")
    resp = httpx.get(f"{base}/rate_limit", headers=headers)
    if resp.status_code == 200:
        rl = resp.json()["resources"]["core"]
        print(f"  ✓ Rate limit: {rl['remaining']}/{rl['limit']} (resets {rl['reset']})")
    else:
        print(f"  ⚠ Could not check rate limit: {resp.status_code}")

    # Check specific permissions
    resp = httpx.get(f"{base}/repos/{org}/{repo}/collaborators", headers=headers)
    if resp.status_code == 200:
        print(f"  ✓ Has collaborator access (can manage PRs/reviews)")
    elif resp.status_code == 403:
        print(f"  ⚠ Missing admin access — reviews/merge may fail")

    print(f"\n  Setup complete. Required PAT scopes:")
    print(f"    - repo (full control of private repos)")
    print(f"    - workflow (update GitHub Action workflows)")
    print(f"    - write:checks (create/update check runs)")
    print(f"\n  Run the benchmark:")
    print(f"    GITHUB_TOKEN=ghp_xxx GITHUB_ORG={org} GITHUB_REPO={repo} python benchmark.py")


if __name__ == "__main__":
    token = os.environ.get("GITHUB_TOKEN", "")
    org = os.environ.get("GITHUB_ORG", "")
    repo = os.environ.get("GITHUB_REPO", "gh-api-benchmark")

    if not token:
        print("ERROR: Set GITHUB_TOKEN env var")
        sys.exit(1)
    if not org:
        print("ERROR: Set GITHUB_ORG env var")
        sys.exit(1)

    setup(token, org, repo)
