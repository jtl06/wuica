# Deploying the wuica API (api.wuica.jacen.li)

Target: the VM `wuica-api`, Ubuntu 26.04 aarch64, 2 OCPU / 12 GB. The server (`server/`) listens on `127.0.0.1:8787`
only. A Cloudflare tunnel (`cloudflared`) connects out to Cloudflare and serves `https://api.wuica.jacen.li`. No inbound
port needs to be open, and the firewall can stay closed except for SSH.

Files in this directory:

- `wuica-api.service`: the systemd unit. It runs as the unprivileged user `wuica`, with `NoNewPrivileges`,
  `ProtectSystem=strict`, `MemoryMax=7G`, no network except localhost, and 2 workers.
- `cloudflared.yml`: the tunnel configuration (`/etc/cloudflared/config.yml`).

Layout on the VM:

```
/opt/node/                 Node.js (official tarball)
/opt/wuica/packages/wuica  the npm package: lib/, dist/ (both WebAssembly modules and the tables, brotli), node_modules/
/opt/wuica/server          the server: lib/, bin/, node_modules/ (node_modules/wuica -> ../../packages/wuica)
```

Everything under `/opt` is owned by root and read-only for the service. The server writes nothing to disk. Its log is
one JSON line per request on stdout (journald). The log never contains the submitted code.

## 1. Build the bundle (on the Mac, in the repository)

```sh
export PATH=$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH
./build-wasm.sh                      # target/wasm32-unknown-unknown/release/wuica_wasm.wasm
(cd packages/wuica && ./build.sh)    # packages/wuica/dist: the modules and data/, brotli-compressed
(cd packages/wuica && npm ci && npm test)
(cd server && npm ci && npm test)

tar -czf /tmp/wuica-api.tgz \
  packages/wuica/package.json packages/wuica/package-lock.json packages/wuica/lib packages/wuica/bin \
  packages/wuica/dist packages/wuica/index.d.ts packages/wuica/LICENSE packages/wuica/licenses packages/wuica/README.md \
  server/package.json server/package-lock.json server/lib server/bin server/deploy
scp /tmp/wuica-api.tgz wuica-api:/tmp/
```

`build.sh` needs `data/` (the tables exported from uiCA) and `assembler/dist/wuica_asm.wasm`. In a worktree, `data`
can be a symlink to the main checkout's.

## 2. Install Node.js (on the VM)

Use Node 22 or later. These commands install the current Node 24 LTS for linux-arm64 from nodejs.org, after checking
its SHA-256:

```sh
NODE_MAJOR=24
base=https://nodejs.org/dist/latest-v${NODE_MAJOR}.x
cd /tmp
file=$(curl -fsSL "$base/SHASUMS256.txt" | awk '/linux-arm64\.tar\.xz$/ {print $2}')
curl -fsSLO "$base/$file"
curl -fsSL "$base/SHASUMS256.txt" | grep " $file\$" | sha256sum -c -
sudo mkdir -p /opt/node
sudo tar -xJf "$file" -C /opt/node --strip-components=1
/opt/node/bin/node --version
```

Ubuntu 26.04's own `nodejs` package (22.22) also works. With it, change `ExecStart` in the unit to `/usr/bin/node`.

## 3. Install the server

```sh
sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin wuica
sudo mkdir -p /opt/wuica
sudo tar -xzf /tmp/wuica-api.tgz -C /opt/wuica
export PATH=/opt/node/bin:$PATH
(cd /opt/wuica/packages/wuica && sudo env PATH=$PATH npm ci --omit=dev --ignore-scripts)
(cd /opt/wuica/server && sudo env PATH=$PATH npm ci --omit=dev --ignore-scripts)
sudo chown -R root:root /opt/wuica
sudo chmod -R a+rX /opt/wuica

# smoke test as the service user (Ctrl-C to stop)
sudo -u wuica env WUICA_WORKERS=2 /opt/node/bin/node /opt/wuica/server/bin/wuica-server.js &
sleep 2; curl -s 127.0.0.1:8787/healthz; echo
curl -s -X POST 127.0.0.1:8787/api/analyze/SKL -H 'Accept: text/plain' -d '{"hex":"4801d84801c349ffcf75f5"}' | head -3
kill %1
```

## 4. Enable the service

```sh
sudo cp /opt/wuica/server/deploy/wuica-api.service /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/wuica-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now wuica-api
systemctl status wuica-api --no-pager
curl -s 127.0.0.1:8787/healthz; echo
journalctl -u wuica-api -f                 # one JSON line per request
```

Settings are environment variables in the unit (`WUICA_*`, listed with their defaults in `server/lib/config.js`). After
changing them, run `sudo systemctl daemon-reload && sudo systemctl restart wuica-api`. A restart is graceful: the server
stops accepting, finishes the running requests (up to 15 s), then exits.

## 5. Create the Cloudflare tunnel

Install `cloudflared` from Cloudflare's apt repository. It provides arm64 packages.

```sh
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared
cloudflared --version
```

Create the tunnel and route the DNS name to it:

```sh
cloudflared tunnel login                         # opens a URL: authorize the zone jacen.li; writes ~/.cloudflared/cert.pem
cloudflared tunnel create wuica-api              # prints the tunnel id; writes ~/.cloudflared/<TUNNEL_ID>.json
cloudflared tunnel route dns wuica-api api.wuica.jacen.li   # CNAME api.wuica -> <TUNNEL_ID>.cfargotunnel.com

TUNNEL_ID=$(cloudflared tunnel list -o json | /opt/node/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).find(t=>t.name==="wuica-api").id))')
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/$TUNNEL_ID.json /etc/cloudflared/
sed "s/TUNNEL_ID/$TUNNEL_ID/g" /opt/wuica/server/deploy/cloudflared.yml | sudo tee /etc/cloudflared/config.yml > /dev/null
sudo cloudflared --config /etc/cloudflared/config.yml tunnel ingress validate
sudo cloudflared service install                 # systemd unit cloudflared.service, reads /etc/cloudflared/config.yml
sudo systemctl enable --now cloudflared
rm ~/.cloudflared/cert.pem                       # only needed to create tunnels and routes
```

Check from anywhere:

```sh
curl -s https://api.wuica.jacen.li/healthz
curl -s 'https://api.wuica.jacen.li/api/archs?fields=id,name'
curl -s -X POST https://api.wuica.jacen.li/api/analyze/SKL -d '{"source":"loop: add rax, [rsi]\n add rsi, 8\n dec rcx\n jnz loop"}'
claude mcp add --transport http wuica https://api.wuica.jacen.li/mcp
```

**TLS for a second-level name:** Cloudflare's free Universal SSL certificate covers `jacen.li` and `*.jacen.li`.
It does not cover `api.wuica.jacen.li`, which is two levels deep. Before the name will work over HTTPS, do one of the
following:

- enable Total TLS, or order an advanced certificate for `api.wuica.jacen.li` (Advanced Certificate Manager);
- use a one-level name instead, such as `api-wuica.jacen.li`, in `cloudflared.yml` and the `route dns` command.

## Client IP and rate limit

Cloudflare sets `CF-Connecting-IP`, and cloudflared passes it on. The server keys its per-IP token bucket on that header
(`WUICA_TRUST_CF_HEADER=1`, the default). It may trust the header because only cloudflared can reach `127.0.0.1:8787`.
The defaults are a burst of 60 requests, then 120 per minute. A compare costs 3 tokens. A Cloudflare WAF rate-limiting
rule can be added in front as a second layer.

## Updating

Build a new bundle (step 1) and copy it to the VM. Then:

```sh
sudo rm -rf /opt/wuica.new && sudo mkdir /opt/wuica.new && sudo tar -xzf /tmp/wuica-api.tgz -C /opt/wuica.new
(cd /opt/wuica.new/packages/wuica && sudo env PATH=/opt/node/bin:$PATH npm ci --omit=dev --ignore-scripts)
(cd /opt/wuica.new/server && sudo env PATH=/opt/node/bin:$PATH npm ci --omit=dev --ignore-scripts)
sudo chmod -R a+rX /opt/wuica.new
sudo rm -rf /opt/wuica.old && sudo mv /opt/wuica /opt/wuica.old && sudo mv /opt/wuica.new /opt/wuica
sudo systemctl restart wuica-api && curl -s 127.0.0.1:8787/healthz
```
