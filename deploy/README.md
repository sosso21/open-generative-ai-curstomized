# STA deployment of Open Generative AI

Copies of the scripts that run the app on the STA VPS. The live copies sit next to the repository, in
`/root/sandbox/ai-project/` (the parent folder of `Open-Generative-AI/`); `publish.sh` refreshes this `deploy/`
folder from them at every publication.

```
/root/sandbox/ai-project/
├── Open-Generative-AI/      this repository (origin = sosso21/open-generative-ai-curstomized, upstream = Anil-matcha)
│   └── output/              generated results, bind-mounted in the container at /app/output
├── compose.yml lib.sh       container definition (WireGuard 10.13.13.1:3100 only) and shared helpers
├── local.env                machine settings, never published (ALERTS_ENV: env file holding DISCORD_WEBHOOK)
├── setup.sh                 build the image from the working copy, start the app and the watcher
├── start.sh / pause.sh      start / pause the app and the watcher
├── uninstall.sh             stop the watcher, remove every Docker object of the app
├── publish.sh               publish the changes on a new branch (see below)
└── watch.sh                 background loop (pidfile .watch.pid, log .watch.log) running publish.sh every 5 min
```

## Generated results

Every result returned by MuAPI is copied by `POST /api/outputs` into
`output/<YYYY-MM-DD>/<YYYYMMDD-HHMMSSmmm>-<model>[-n].<ext>` with a `.json` sidecar (model, prompt, request
id, source URL, input). Only `https://cdn.muapi.ai` and `https://d3adwkbyhxyrtq.cloudfront.net` are accepted;
add a host with the `OUTPUT_ALLOWED_HOSTS` environment variable (comma separated) in `compose.yml`.

## Publication (publish.sh / watch.sh)

For each change of the working copy or new file in `output/`:

1. branch `change/YYYY-MM-DD_HH-MM-SS` (Africa/Algiers time) created from the current branch;
2. everything committed, media of `output/` through Git LFS (`.gitattributes`);
3. push over HTTPS with the gh login of root (helper of `gh auth setup-git`, set in the repo config only),
   then checks: remote branch head = local commit, every LFS object present on GitHub;
4. only then the published files are removed from `output/` (removal committed locally, sent with the next branch);
5. Discord notification with the branch and the number of files.

`watch.sh` is started by `setup.sh` / `start.sh` and stopped by `pause.sh` / `uninstall.sh`. It is not a
system service: after a reboot of the VPS run `./start.sh` again. Run `./publish.sh` by hand at any time.

## Reinstall from scratch

```bash
mkdir -p /root/sandbox/ai-project && cd /root/sandbox/ai-project
gh repo clone sosso21/open-generative-ai-curstomized /tmp/oga
cp /tmp/oga/deploy/*.sh /tmp/oga/deploy/compose.yml . && rm -rf /tmp/oga && chmod 700 *.sh
printf 'ALERTS_ENV=/path/to/env-with-DISCORD_WEBHOOK
' > local.env && chmod 600 local.env   # optional
./setup.sh   # clones the repository with the gh login, builds and starts
```

Upstream updates are merged by hand: `git fetch upstream && git merge upstream/main` (the former submodules
`packages/Vibe-Workflow`, `packages/Open-Poe-AI`, `packages/Open-AI-Design-Agent` are vendored here).
