# Sweep tools

Each is a single static binary from its GitHub release. Install into `~/.local/bin`, never into the repo.

```bash
mkdir -p ~/.local/bin /tmp/sweep-tools && cd /tmp/sweep-tools
gh release download -R gitleaks/gitleaks -p '*linux_x64.tar.gz' --clobber
gh release download -R zizmorcore/zizmor -p 'zizmor-x86_64-unknown-linux-gnu.tar.gz' --clobber
gh release download -R lycheeverse/lychee -p 'lychee-x86_64-unknown-linux-gnu.tar.gz*' --clobber
sha256sum -c lychee-x86_64-unknown-linux-gnu.tar.gz.sha256
for f in *.tar.gz; do tar -xzf "$f"; done
find . -maxdepth 2 -type f \( -name gitleaks -o -name zizmor -o -name lychee \) -exec install -m755 {} ~/.local/bin/ \;
export PATH="$HOME/.local/bin:$PATH"
```

On another OS or architecture, pick the matching asset from `gh release view -R <repo>`.

## Commands

| Tool | Command (from the repo root) |
| --- | --- |
| zizmor | `env -u GH_TOKEN -u GITHUB_TOKEN zizmor --offline --no-progress .github/` |
| gitleaks | `gitleaks git --redact --no-banner .` |
| lychee | `lychee --offline --no-progress --include-fragments $(git ls-files '*.md')`, then the same without `--offline` |
| knip | `npx --yes knip --no-progress` from a project directory, after `npm ci --ignore-scripts` |

- zizmor stays `--offline` with no GitHub token, so it never calls the API or logs a token.
- gitleaks prints redacted matches only. Never paste an unredacted match into a commit, PR or issue.
- knip reports; do not run `knip --fix`. Its findings need the `rg` check in step 5 first.

If a tool cannot be installed, do the step by hand (`git grep`, `curl -sIL`) and record the gap in the ledger.
