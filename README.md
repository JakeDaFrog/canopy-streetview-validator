# Street View Canopy Validator

A browser-based tool for ground-truthing satellite canopy data using Google Street View — including **historical imagery** — to identify when trees were removed.

Built as a static GitHub Pages site: no server required, runs entirely in the browser.

---

## Features

- **Bulk coordinate input** — paste lat/lng pairs or upload a CSV file
- **Batch processing** — finds the nearest outdoor Street View panorama for each coordinate
- **Interactive map** — colour-coded markers (green = found, red = no coverage); click to add single points
- **Embedded 360° viewer** — view the panorama directly in the page
- **Historical timeline** — loads all historical captures at each location; click a date to jump to it
- **CSV export** — download results with pano IDs, dates, and distances
- **API key is never committed** — each browser stores its own key in localStorage

---

## Setup

### 1. Get a Google Maps API Key

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project and **enable billing** (Street View has a free monthly credit)
3. Enable these APIs:
   - **Maps JavaScript API**
   - **Street View Static API** *(needed for metadata lookups)*
4. Go to **APIs & Services → Credentials → Create credentials → API key**
5. **Restrict the key** to your GitHub Pages domain for security:
   - Under *Application restrictions* → **HTTP referrers**
   - Add: `https://YOUR_USERNAME.github.io/*`

### 2. Deploy to GitHub Pages

```bash
# Create a new repo on GitHub first (e.g. "canopy-streetview-validator")
# Then from this directory:

git init
git add .
git commit -m "Initial commit: Street View Canopy Validator"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/canopy-streetview-validator.git
git push -u origin main
```

Then in your GitHub repo:
- Go to **Settings → Pages**
- Source: **Deploy from a branch**
- Branch: **main** / **(root)**
- Click **Save**

Your site will be live at `https://YOUR_USERNAME.github.io/canopy-streetview-validator/`

### 3. Share with your team

Send your team the GitHub Pages URL. Each person:
1. Opens the URL in their browser
2. Enters their own Google Maps API key on first load (stored locally, never leaves their browser)
3. Starts using the tool immediately

---

## Using the Tool

### Batch Processing

**Paste tab:**
```
35.28280, -120.65960
35.29001, -120.67002, Tree A site
35.30012, -120.68003
```
One coordinate per line. Accepted formats: `lat, lng` · `lat lng` · `lat, lng, label`

**Upload CSV tab:**
Drop in any CSV file. The tool auto-detects lat/lng columns by name (supports `lat`, `latitude`, `y`, `lon`, `lng`, `longitude`, `x` and common GIS variants). Extra columns are ignored.

Click **Find Street Views** — a progress bar tracks the batch. Results appear as they arrive.

### Viewing Historical Imagery

1. Click any result in the list (or a map marker) to load its Street View
2. The **Historical imagery** strip at the bottom of the viewer shows all available capture dates
3. Click a date button to jump to that historical panorama
4. If the historical timeline can't be fetched (rare CORS restriction), click **Open in Google Maps** for full time-travel controls

### Identifying Tree Removals

- Compare dates in the historical timeline: look for the first capture where the tree canopy is absent
- Use the heading/pitch controls in the viewer to look around and up
- Export results to CSV and annotate with your team's observations

---

## CSV Export Columns

| Column | Description |
|---|---|
| `label` | Input label or auto-generated name |
| `input_lat` / `input_lng` | Your input coordinates |
| `found` | `yes` / `no` / `pending` |
| `pano_id` | Google Street View panorama ID |
| `pano_lat` / `pano_lng` | Actual panorama location |
| `imagery_date` | Date of the *current* (most recent) panorama |
| `distance_m` | Distance in metres from input point to panorama |

---

## Notes

- **API costs:** The Maps JavaScript API has a $200/month free credit. Each `StreetViewService.getPanorama()` call counts against the *Street View* SKU. For typical research batches (hundreds of points) costs are negligible.
- **Rate limits:** The tool processes 5 coordinates concurrently with a 250 ms delay between batches to stay within API limits.
- **Historical data:** Uses the same undocumented Google endpoint as the original Python tool. It works from most browsers, but if CORS blocks it, the Google Maps link provides equivalent functionality.
- **API key security:** Restrict your key to your GitHub Pages domain in Google Cloud Console to prevent unauthorised use.

---

## File Structure

```
canopy-streetview-validator/
├── index.html          # Main app (setup modal + layout)
├── css/
│   └── style.css       # All styles
├── js/
│   └── app.js          # All application logic
└── README.md
```
