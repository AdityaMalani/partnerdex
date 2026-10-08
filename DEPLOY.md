# Deploying PartnerDex

This guide outlines the production deployment process for PartnerDex.

---

## 1. How the project is designed to run and deploy

PartnerDex is designed as a single, lightweight Node.js process. It runs an Express server serving both the REST API and the compiled frontend dashboard, accompanied by a background synchronization loop that queries the Shopify Partner API.

### Infrastructure Architecture
- **Single Instance:** PartnerDex must run on a **single instance** (one container/machine) with a persistent volume attached. Because it uses an embedded, local SQLite database, deploying multiple nodes would result in data inconsistency and conflicting background sync workers.
- **Persistent Volume:** A persistent disk volume must be mounted at `/data` to store the SQLite database. Without persistent storage, redeploying or restarting the container would cause data loss and trigger a complete historical backfill.
- **Docker-Ready:** The codebase includes a `Dockerfile` and a `.dockerignore` file. The container is multi-staged, building the server and web frontend using TypeScript and Vite, and exporting a clean, runtime-only image without build tools.

---

## 2. Steps to deploy on fly.io

PartnerDex is pre-configured for deployment on Fly.io using the template `fly.example.toml`.

### Step 2.1. Prerequisites
1. Install `flyctl` and authenticate with your Fly.io account:
   ```bash
   brew install flyctl
   fly auth login
   ```
2. Locate or create a Partner API client in your **Shopify Partners Dashboard → Settings → Partner API clients**. Ensure the client has both **View financials** and **Manage apps** permissions.

### Step 2.2. Create your configuration
1. Copy the configuration template to create your production `fly.toml` file (which is gitignored by default):
   ```bash
   cp fly.example.toml fly.toml
   ```
2. Open `fly.toml` and configure the following:
   - `app`: Set your unique Fly app name.
   - `primary_region`: Set the target deployment region.
   - Under `[env]`, set `PARTNER_ORGANIZATION_ID` to your Shopify Organization ID (found in the Partners Dashboard URL: `partners.shopify.com/<id>/...`).

3. Initialize the Fly application:
   ```bash
   fly apps create <your-app-name>
   ```
   *Warning: Do not run `fly launch`. It will overwrite the customized template, dropping essential settings such as volume mounts and health checks.*

### Step 2.3. Create the persistent volume
Create a 1 GB persistent volume in the same region as your application:
```bash
fly volumes create partnerdex_data --size 1 --region <your-region> --yes
```
The volume name `partnerdex_data` must match the `source` name under the `[mounts]` section in your `fly.toml`.

### Step 2.4. Set production environment credentials
Open your `fly.toml` and define your credentials directly within the `[env]` section:
- `PARTNER_API_TOKEN`: Your Shopify Partner API token.
- `DASHBOARD_PASSWORD`: Set a secure password (at least 8 characters) to restrict dashboard and API access.

*Note: Since these credentials live in a gitignored `fly.toml` file, keep this file secure. If you lose `fly.toml`, you must rebuild your configuration.*

### Step 2.5. Deploy the application
Deploy PartnerDex to Fly.io:
```bash
fly deploy
```

On first startup, the server automatically initializes an empty SQLite database and starts backfilling historical records from `SYNC_START_DATE`. You can monitor the process by reading the logs:
```bash
fly logs
```

### Step 2.6. Verify the deployment
Verify that the application is running and accessible:
```bash
curl https://<your-app-name>.fly.dev/api/health
```
The health check endpoint is unprotected and returns `200 OK` when the server is healthy. To access reports, navigate to `https://<your-app-name>.fly.dev` in your browser and log in with your configured password.

---

## 3. Details and configurations

### Foreground Backfill Seed (Optional)
For larger Shopify accounts, the initial historical backfill might take some time. If you prefer to run the first sync manually in the foreground to monitor progress, execute:
```bash
fly ssh console -C "node /app/dist/cli.js sync"
```
You can also run internal diagnostics or validations on your production instance:
```bash
fly ssh console -C "node /app/dist/cli.js doctor"
fly ssh console -C "node /app/dist/cli.js validate"
```

### Backups and Data Portability
Since the SQLite database resides on a single physical disk, you should perform regular backups of the database file (`/data/partnerdex.db`). Most tables are disposable (rebuildable from the Partner API), but **Role-4 tables are not** — `app_reviews`, notification channels/deliveries, and especially **`contacts` / `contact_shops` / `contact_suppressions`**. Once a contacts import lands, that SQLite file holds the only copy of the send list.

#### 1. Fly volume snapshots (primary)
Fly takes **daily snapshots automatically** and keeps them for **5 days** by default. That is enough for PartnerDex — confirm in the Fly dashboard under the volume (it will say something like “snapshots are taken daily and kept for 5 days”), or:

```bash
# Find the volume id (NAME should be partnerdex_data)
fly volumes list

# List snapshots — requires the volume id
fly volumes snapshots list <volume-id>
```

Before any contacts import (`contacts:import --commit`) or destructive maintenance, take an extra manual snapshot:

```bash
fly volumes snapshots create <volume-id>
```

Restore = create a new volume from a snapshot, then attach it (see [Fly volume snapshots](https://fly.io/docs/volumes/snapshots/)).

#### 2. Full DB copy (off-box)
To download a local copy of your production database:
```bash
fly ssh sftp get /data/partnerdex.db ./partnerdex-backup.db
```

#### 3. Contacts-only dump (portable Role-4 backup)
Belt-and-braces alongside volume snapshots — a JSON export of just the three contacts tables, safe to pull off the machine before destructive work and restore into an empty DB if the volume is lost:

```bash
# On the machine / via ssh
fly ssh console -C "node /app/dist/cli.js contacts:dump --out=/data/contacts-dump.json"
fly ssh sftp get /data/contacts-dump.json ./contacts-dump.json

# Restore into a DB that already has the contacts schema
partnerdex contacts:restore --from=./contacts-dump.json
```

`contacts:restore` **replaces** the three tables wholesale — it is a round-trip restore, not a merge. Archive your source contacts CSV permanently (object storage) as the origin record, independent of PartnerDex.

#### 4. Contacts CSV import (one-time)
After deploy, and once a volume snapshot exists. The CSV must use these **exact** headers (extra columns are ignored):

```csv
email,first_name,last_name,myshopify_domain,role,suppressed
ada@example.com,Ada,Lovelace,acme.myshopify.com,owner,false
bob@example.com,Bob,Builder,solo.myshopify.com,staff,true
```

- `role` must be `owner`, `staff`, or `collaborator`
- `suppressed` is `true` / `false` (also accepts `1`/`0`, `yes`/`no`; blank = false)
- Rows without a valid email are skipped; blank `myshopify_domain` keeps the contact unlinked

```bash
# Read-only: is shops.myshopify_domain populated?
fly ssh console -C "node /app/dist/cli.js contacts:coverage"

# Preview (default — writes nothing)
fly ssh console -C "node /app/dist/cli.js contacts:import --from=/data/contacts.csv --app-id=<your-app-id>"

# Commit
fly ssh console -C "node /app/dist/cli.js contacts:import --from=/data/contacts.csv --app-id=<your-app-id> --commit"
```

Set `CONTACTS_INGEST_TOKEN` (Fly secret) before any app producer starts calling `POST /api/contacts/ingest`.

### Resilient Redeploys
During deployments, the running container stops and restarts, which may interrupt an active sync loop. This is completely safe; PartnerDex's synchronization logic is fully incremental, re-reading records from a 3-day overlap window prior to the last known watermark to catch late-arriving events.

### Background Worker Architecture
To prevent CPU-intensive SQLite write operations from blocking the API and health-check HTTP thread, the sync worker runs as a separate forked child process. This pattern keeps the web server responsive and frees system memory back to the host OS when syncing finishes.

### Scaling & High Availability
- **Do not scale horizontally (`count > 1`).** Adding multiple nodes will create separate persistent volumes, leading to isolated and unsynced SQLite databases, alongside duplicate calls to the Shopify API.
- To scale for increased loads, scale vertically by upgrading the machine's CPU and Memory:
  ```bash
  fly scale vm shared-cpu-2x --memory 1024
  ```

### Cost and Auto-Stopping
By default, Fly.io may stop inactive machines to save costs. However, because PartnerDex depends on its background worker to continuously sync Shopify API records, auto-stopping is disabled (`auto_stop_machines = false` in `fly.toml`). This ensures that the background sync continues to run every 5 minutes and dashboard metrics are kept up to date.

### Reverse Proxy and Trust Proxy Configuration
When deployed on Fly.io, TLS is terminated at Fly's edge proxy, which routes unencrypted plain HTTP requests to the container.
- For secure cookie handling and accurate IP-based rate limiting (preventing brute force attempts on the dashboard login), the application relies on the `TRUST_PROXY = "true"` setting in `fly.toml`.
- Leave `TRUST_PROXY` disabled during local development to prevent IP spoofing via mock headers.
