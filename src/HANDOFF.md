# Shop Cuts: handoff notes (read this first)

Updated Nov 12, 2026. This handoff is written for a **new chat that will build a welding add-on**, the next stage of fabrication after cutting and assembly.

---

## 1. What Shop Cuts is

Shop Cuts is the shop-tablet app for **Ridgeway Aluminum railings**. Matt (Railing Operations Manager) owns it.

- **Who uses it:**
  - **Dave** runs the saw and cuts top rails, channels and posts.
  - **Jim** does post blocking, bracketing and assembly.
  - Other employees sometimes help out in the shop.
  - Matt manages from his computer and his phone.
- **What it shows:** it reads Excel cut sheets from the Google shared drive folder **Ready To Fab**:
  `G:\Shared drives\Ridgeway Aluminum Ltd\Ridgeway\Departments\Railings\Ready To Fab` (folder id `1VjSZ_HSrvG_Jae4s2dxy_z0dJt8CwE1g`).
  - Tabs shown: Cover, Post Sheet and Cut Sheet, plus Custom posts, Sleeves and other extra tabs when the job uses them.
  - Unit layout drawings come from the INPUT sheet.
- **How the crew uses it:** they tick boxes as they go. Ticks sync live between tablets.
- **Sign-offs:** each stage is signed off with a name. When Assembly is signed off, the job is marked complete:
  - a PDF hard copy goes to Matt's My Drive;
  - the xlsx moves out of Ready To Fab into Completed.
- **Live app:** https://mlieuwen-code.github.io/shop-cuts/ (GitHub repo `mlieuwen-code/shop-cuts`, served by GitHub Pages, installable as a PWA).
- **Claude artifact preview:** https://claude.ai/artifact/EDX9gKsuCy9XrBnJY7hwaR
  - It reads Ready To Fab through the Google Drive connector.
  - In the preview, ticks and priority stay on that one device.
- **Sister app:** the field app **Rail Measure** (repo `mlieuwen-code/cut-sheets`), which has its own separate chat. It writes the cut sheets that Shop Cuts reads. Both apps share one Apps Script backend.

### How Matt likes to work
- He wants it built, published and deployed, not explained. Every change goes to **both** the live GitHub Pages app and the artifact.
  - Don't send zips or rewrite this file on every change; update the handoff only when he asks.
- The tablets are a Samsung Tab A11+, used in landscape at the saw, often by people wearing gloves. That means:
  - big tap targets;
  - plain words;
  - the yellow/white zebra rows from the Excel file;
  - green for done;
  - #9C0006 red for floating rails and warnings.
- He tests on the real tablets and reports back briefly, e.g. "Tablet not updating". Check facts yourself (live version, server data) before answering.
- Brand orange is `#E8590C`. The app icon is a saw blade.

---

## 2. Build and deploy

The source is this folder. Run `python3 build_shop.py`. It writes:
- `out/shop-app/`: what goes live (`index.html`, `sw.js`, `app.webmanifest`, icons).
- `shop/shop-artifact.html`: the artifact preview.
  - Publish it to the URL above.
  - Its capabilities: `mcp` → Google Drive (`search_files`, `download_file_content`).

**Before every push**, run this syntax check. A broken push takes the tablets down:
```
node -e "new Function(require('fs').readFileSync('out/shop-app/index.html','utf8').split('<script>').pop().split('</script>')[0])"
```

**To deploy:** clone `mlieuwen-code/shop-cuts`, run `cp out/shop-app/* <clone>/`, then commit and push to `main`.
- Commit as `Matt <m.lieuwen@gmail.com>`.
- GitHub Pages takes 1–2 minutes. Its build has failed with "Internal server error" on GitHub's side a few times. When that happens, push an empty commit to rebuild and check again:
  `curl -s "https://mlieuwen-code.github.io/shop-cuts/?x=$RANDOM" | grep -o "var VERSION = '[^']*'"`
- Matt interrupts long waits, so do quick checks rather than loops that run for minutes.

**Version stamp:** `__BUILD__` is replaced at build time with Pacific time `M.D.HMM`, e.g. `11.10.654`. It shows at the bottom of the job list.

**How updates reach the tablets:**
- The service worker (`deps/sw-shop.js`) is network-first, falling back to the cache after 3 s.
- `reg.update()` runs when the app comes to the front and when someone taps **Refresh list**.
- On `controllerchange` the app reloads once and shows an "Updated" toast. "Refresh list" also shows an "Up to date" toast.

---

## 3. Backend (Google Apps Script)

The Apps Script project is **"Cut Sheets App"**, shared with the field app:
- Editor: https://script.google.com/home/projects/1AbaEatjFPb9Epa-4g1TvSspui0R6jPZnXDgwkzNd5dGx1MIomERh9HRN/edit
- Web app deployment ID: `AKfycbzfJwNBkDvCyr3_mzOfKA5q_bELUvgF2WyBoN8fEH86KNsbvvuhpJL575SkwAcsx3zj0A` (in `build_shop.py` as `WEBAPP`). It's on **version 7**.
- It runs as matt@ridgewayaluminum.com, with access set to Anyone; requests are guarded by the crew PIN **4417**.

Files in the project:
- `Code.gs` belongs mostly to the field app.
  - In doPost the shop uses `fablist`, `fabopen`, `progget` and `progset`.
  - The last branch is `else if (!(out = shopAction(req))) throw new Error('Unknown request');`, which hands everything else to ShopCompleted.gs.
  - **The copy of Code.gs in this folder may be older than the live one.** The field-app chat changed it (it now loads the field app page from GitHub). Always edit the live editor; never paste over Code.gs from this folder.
- `ShopCompleted.gs` is shop-only, and this folder's copy matches the live one. Its actions:
  - `fablist2`: `{files, done, prio}`. Ready To Fab files, plus completed jobs from the last 50 days, plus the priority list.
  - `fabopen2`: opens a job from Ready To Fab or from Completed.
  - `complete`: takes `{id, at, by, html}`. It turns the html into a PDF in My Drive `Shop Cuts Completed`, writes `Shop Cuts completed {json}` into the xlsx description, and moves the xlsx to the `Completed` folder that sits next to Ready To Fab.
  - `uncomplete`: moves the job back to Ready To Fab.
  - `prioset`: saves the priority list (file ids) in the Script Property `shopPrio`.

Progress is stored in Script Properties as `prog:<fileId>`, **with a limit of 8.5k characters per job** (`progset` rejects anything longer). A 300-box job uses about 6.2k, so there isn't much room left for more data per job.

**Deploying the backend:** edit, then Save, then **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**.
- This can be done from Matt's Chrome through Claude in Chrome. Use `monaco.editor.getModels()` to read and edit the file contents, then click Save.
- If the backend hasn't been deployed yet, the client falls back gracefully: `apiNew('new','old')` retries the old action when the reply says "Unknown request".

---

## 4. App source map

- `shop/head.html` is the CSS, `shop/body.html` the markup, and `shop/app.js` the app (about 1,050 lines of plain ES5 with no framework).
- `bubble.js` holds the layout zoom bubbles. `live/app.js` is a read-only copy of the field app; `build_shop.py` lifts its layout drawing code (`JOINT_CODES … layoutSvg`) and patches it:
  - E–E gaps;
  - mid posts;
  - float post spacing;
  - zoom bubbles;
  - no feet.
- `deps/` holds the field-artifact snapshot (it provides JSZip, sliced out by line number), the service worker template and the icons.
- `test-files/` holds Test Building and Crowded A/B/C xlsx. `tests/` holds mkcrowd.py and s10.js.

Key pieces of `app.js`:
- **Parsing:** the xlsx is read with JSZip, including styles, print areas, hidden rows and columns, and merges.
  - A ✓ column ticks the cell to its left. `L.chk[r:c].head` is the column heading.
  - Files saved straight from the field app (`fullCalcOnLoad`, not yet calculated) are refused with a request to re-save in Excel.
- **Tick keys:** `'<SHEET NAME>|c<row>:<col>'` for a box, `'…|r<row>'` for a tappable row.
  - Storage shortens them: `'CUT SHEET|c9:2'` → `C9:2`, `'POST SHEET|c…'` → `P…`.
- **Progress merge (format v2):**
  - Every tick and untick carries a timestamp in seconds. Copies merge box by box, and the latest change wins (a tick wins a tie).
  - Times are stored in base 36, relative to `db`.
  - `tlp` and `tlap` are packed tick-time lists for cutting and assembly; they feed the fab timer.
  - `tot` is the box count, so the list can show a percentage on tablets that haven't opened the job.
  - Functions: `decodeProg / encodeProg / mergeProg / curState / applyState / setTick`.
- **Sync:** `syncNow` (pull, merge, render, push) runs every 30 s while a job is open, and again when the app comes to the front.
  - The job list runs `loadList()` every 60 s and when the app comes to the front. `pullAll` pulls every job's progress for the percentages.
- **Stages:** `STAGES` array, `stageCard`, `signOff`, `tickKind(key)` (`'cut'` or `'asm'`), and `allDone`.
  - **Cutting complete** is tied to the Top rail and Channel boxes on the Cut Sheet plus the Post-cutting boxes on the Post Sheet.
  - **Assembly complete** is tied to the Rail tag boxes on the Cut Sheet plus the Blocking/Bracketing boxes on the Post Sheet.
  - The names are Dave, Jim, or Other (typed names are remembered). The undo times are `finX` and `asmX`.
- **Completion:**
  - Signing off Assembly calls `sendComplete` (with `printHtml` for the PDF).
  - Failed sends are queued in `shop-pending` and retried.
  - `catchUpCompleted()` handles jobs whose Assembly was signed off on an old version.
- **Job list:** an orange ⚡ Priority card first (order set by Matt), then a green In progress card sorted by % done, then Not started, newest first.
  - Completed jobs show for 50 days in a collapsible section with a search box.
- **Cut Sheet:**
  - The sort bar offers Unit Order, Top rail Longest/Shortest, Channel Longest/Shortest and **Optimal Cut**.
  - Optimal Cut packs top rails onto 300" sticks. It uses the cost sheet's STICK CALC rule (each piece takes its length + 1/8") and never plans more sticks than first-fit decreasing would.
  - Sorting moves the unit layouts to the bottom, collapsed.
  - When every top rail is ticked, the sort switches to Longest Channel automatically.
  - Floating rails' tags are shown in red, and a black divider separates Right from L Post.
- **Post Sheet:**
  - Section boxes: 1 Post cutting, 2 Blocking, 3 Bracketing.
  - Post and block heights are highlighted.
  - A custom block height (anything not 38 5/16) triggers the pop-up "Mount the blocks at this height".
- **Manager screen:** hold the logo for 2 s or tap it 5 times quickly, then enter PIN **5742**. It holds:
  - the Job priority editor (also usable from a computer browser);
  - Fab times: who cut and who assembled each job, and the cutting and assembly time, counting only active time (gaps over 25 min are left out).
- **localStorage keys:**
  - `shop-sum:<id>`, `shop-prog:<id>`, `shop-info:<id>`, `shop-sort:<id>`, `shop-tab`;
  - `shop-prio`, `shop-pending`, `shop-others`, `shop-done-open`, `ridgeway-crew-pin`;
  - IndexedDB kv keys `list` and `donelist`.

---

## 5. Welding add-on: starting points for the new chat

**Ask Matt first** (none of this is decided):
1. **What gets welded and how it's checked off:** per rail tag, per post, per unit, or per weld type (e.g. post base plates, corners, picket panels, gates)? Which sheet holds that information? Possibly the Cut Sheet rail tags or Post Sheet rows, or something new in the workbook.
2. **Who welds** (names for the sign-off), and whether it's a separate tablet or station.
3. **Where welding falls in the order:** after Assembly, between Cutting and Assembly, or in parallel with them?
4. **Whether he wants weld time tracked** like cutting and assembly.
5. **Same app or separate app:**
   - (a) a third stage, "Welding complete", inside Shop Cuts, optionally with a Welding tab or view;
   - (b) a separate PWA (e.g. `/shop-cuts/weld/` or its own repo) that reuses the same backend and job list.

**Recommendation: build it inside Shop Cuts as a third stage** unless Matt wants a separate install. It reuses the xlsx parsing, live sync, job list, priority, sign-off UI, fab timer and completion flow for free. A separate app would mean duplicating all of that, and both apps would have to stay compatible with the same `prog:<id>` data.

**Things that must change whichever way it goes:**
- **Completion trigger.** Right now *Assembly complete* sends `complete`, which moves the xlsx out of Ready To Fab. Once welding comes after assembly, completion has to move to the last stage. Otherwise welders won't see the job. Look at `signOff`, `sendComplete`, `catchUpCompleted` and the `asm` checks in `renderList` / `jobStatus`.
- **Stage plumbing:**
  - Add `{ k: 'wld', kind: 'wld', … }` to `STAGES`.
  - Extend `tickKind`.
  - Add `wld` / `wldX` and a `tlwp` time list to `decodeProg / encodeProg / mergeProg / curState / applyState`. The merge loop over `['fin','asm']` needs `'wld'` added.
  - Extend `fabTime` and the manager table.
  - Old tablets will drop unknown fields when they re-encode. That's harmless only if the merge on newer tablets keeps the field, so add the fields to the merge first and ship before anyone relies on them.
- **8.5k limit.** New weld boxes add about 20 characters each to `prog:<id>`. If welding adds many boxes, consider a separate `wprog:<id>` property, which needs a new Apps Script action.
- **Box ownership.** If welding ticks reuse existing boxes (e.g. rail tags), they'll collide with assembly. Give welding its own boxes or keys, such as `W<row>` short keys added to `KEYS_SHORT`.

**Workflow reminders:** syntax-check every build before pushing; test with Playwright using mocked `script.google.com` routes (see section 6); publish the artifact and push live together; deploy Apps Script changes as a New version on the existing deployment, never as a new deployment, because the URL must stay the same.

---

## 6. Testing

- Playwright and Chromium are installed. Serve `out/shop-app/` from a small Node http server, and mock the backend with `ctx.route(/script\.google\.com/, …)`:
  - answer `fablist2` with the files, done and prio lists;
  - answer `fabopen2` with the b64 of a test xlsx;
  - answer `progget` / `progset` from an in-memory store.
- Seed the crew PIN in localStorage with an init script.
- To test two tablets, use two browser contexts sharing the same mocked store.
- File-based previews need a `<meta charset="utf-8">` prefix, or · and × come out garbled.

---

## 7. Open items

- **Saw-tablet ticks:** on Nov 9 some of Dave's ticks hadn't reached the server. The computer showed exactly what the server had. The probable cause was an old app version or no signal on Dave's tablet. It's unconfirmed whether this is resolved.
- **Matt's Samsung tablet** won't do a full PWA install of Shop Cuts. It has no WebAPK, although Rail Measure installs fine. He uses a home-screen shortcut. USB debugging was offered for later.
- **Offered and not requested:**
  - reduce fractions (14/16 → 7/8);
  - load field crew names into `FIELD_CREW`;
  - change "no offcut" to show the true 1/8" sliver.
- **Channel optimal cut** was dropped on purpose. They gang-cut channel 3 sticks at a time, and Matt decided a channel plan was too complex.
