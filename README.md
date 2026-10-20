# Kina Ledger

A crafting profit calculator for AION 2 (Global client). It ranks every craft by expected profit per attempt, comparing three ways to source materials:

- buying everything,
- gathering what you can,
- gathering and counting the gathered materials at what they'd sell for.

It also covers success rates by item grade and level difference, Splendent combo procs, and price history.

Prices are shared between the people you add. Anyone can paste a price list, for example a page copied from [aion2.exchange](https://aion2.exchange/), on the Import tab.

Fan-made. Not affiliated with NCSOFT. Recipes come from [AION2 Hub](https://aion2hub.com/tools/crafting-calculator)'s public recipe pages.

## How it's put together

| File | What it is |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The whole site. No build step. |
| `config.js` | Your Firebase project's web config. Leave `firebase: null` to run without a shared price book. |
| `data/catalog.json` | Every Global recipe. Rebuilt by `tools/update-catalog.js`. |
| `firestore.rules` | Who can read and write the shared price book. |

Without Firebase the site still works. Each visitor's prices are just kept in their own browser.

## Setting up the shared price book (free)

1. **Create a Firebase project** at https://console.firebase.google.com. You don't need Google Analytics. The free Spark plan is enough.
2. **Add a web app**: Project settings → General → Your apps → Web. Copy the `apiKey`, `authDomain`, `projectId` and `appId` into `config.js`.
3. **Turn on Google sign-in**: Build → Authentication → Sign-in method → Google → Enable.
4. **Allow your site to sign people in**: Authentication → Settings → Authorized domains → add `shotyu0.github.io`.
5. **Create the database**: Build → Firestore Database → Create database. Choose production mode, and the region nearest you.
6. **Publish the rules**: Firestore Database → Rules. Replace everything with the contents of `firestore.rules`, then Publish.
7. **Add yourself and your friends**: Firestore Database → Data → Start collection `members`. For each person, add a document:
   - Document ID: their Google email address, all lowercase.
   - Field `role` (string): `owner` for you, `member` for everyone else.

   Only people listed here can see or change anything. To remove someone, delete their document.

### What each role can do

| | Owner | Member | Anyone else |
| --- | --- | --- | --- |
| See rankings and prices | ✓ | ✓ | Only their own browser's copy |
| Enter and paste prices | ✓ | ✓ | Only their own browser's copy |
| Their own crafting levels | ✓ | ✓ | Only their own browser's copy |
| Edit recipes and shared settings, delete items, import a full export | ✓ | | |

## Putting it on GitHub Pages

1. Create a repository on GitHub and push these files to the `main` branch.
2. Settings → Pages → Build and deployment → Deploy from a branch → `main` and `/ (root)`.
3. The site appears at `https://shotyu0.github.io/KinaCalc/`.

### Optional hardening

- In Google Cloud console → APIs & Services → Credentials, open the Browser key Firebase created. Under Application restrictions, choose Websites and add `https://shotyu0.github.io/*`. Other sites then can't use your key.
- Firestore's free plan allows 50,000 reads and 20,000 writes a day. If you ever hit it, the page says so and works again the next day.

## Running it locally

The page loads `data/catalog.json`, so open it through a local web server rather than as a file:

```
npx serve .
```

## Updating recipes after a game patch

```
node tools/update-catalog.js
```

It reads AION2 Hub's recipe pages at a gentle rate and only fetches pages it hasn't seen. Raw pages are cached in `tools/.cache/`, which isn't committed. Pass `--refresh` to read everything again.

How the import handles AION2 Hub's data:

- **Unreleased tiers:** recipes listed without a mastery level are treated as not in the Global client yet.
- **Splendent items:** these only come from combo procs. Their Transfer Crafting recipes are shown for reference only, because the result is bound to the character.

## Security notes

- **Nothing in this repository is secret.** Firebase web config only identifies the project. Access is enforced by `firestore.rules`.
- **Members are listed by email in Firestore, not in this repository.**
- **The page only loads code from this site and pinned Firebase scripts.** A Content-Security-Policy restricts where code can load from. The Firebase scripts are pinned to one version, with integrity hashes.
- **Shared data can't inject code into the page.** Everything members enter is escaped before it's shown, and the rules limit which fields a price entry can have and how big it can be.
