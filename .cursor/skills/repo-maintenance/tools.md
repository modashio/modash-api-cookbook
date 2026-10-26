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
| lychee | `lychee --offline --no-progress --include-fragments $(git ls-files '*.md' '.github/*.yml')`, then the same with `--exclude localhost` in place of `--offline` |
| knip | `npx --yes knip --no-progress` from a project directory, after `npm ci --ignore-scripts` |

- zizmor stays `--offline` with no GitHub token, so it never calls the API or logs a token. When it reports suppressed findings, rerun once with `--persona=auditor` to see them.
- gitleaks prints redacted matches only. Never paste an unredacted match into a commit, PR or issue.
- knip exits non-zero on unused exports alone. It reads any `tsconfig.json` as a use of `typescript`, so confirm that package with `rg` by hand. Do not run `knip --fix`.

If a tool cannot be installed, do the step by hand (`git grep`, `curl -sIL`) and record the gap in the ledger.

## Repo settings

Read-only, with `R=modashio/modash-api-cookbook`:

| Setting | Endpoint | Readable fallback on `403` |
| --- | --- | --- |
| Branch protection, required checks | `gh api repos/$R/branches/main/protection` | `gh api repos/$R/branches/main --jq .protected` and `gh api repos/$R/rules/branches/main` |
| Fork PR workflow approval | `gh api repos/$R/actions/permissions/fork-pr-contributor-approval` | none |
| Default workflow token permissions | `gh api repos/$R/actions/permissions/workflow` | none |

## API reference

`https://docs.modash.io/llms.txt` lists every docs page. Each page has a `.md` twin, which is the quickest way to read the cost text.
