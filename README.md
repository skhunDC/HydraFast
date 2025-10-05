# HydraFast

HydraFast is a mobile-friendly Google Apps Script progressive web app designed to guide users through water-only fasting. It tracks your fasting timeline, keeps hydration front-and-center, and provides motivational coaching every step of the way.

## Features
- **Interactive fasting timeline** with hour-by-hour phases and focus tips
- **Deep healing phase coverage** from 48 hours through 7+ days, including immune renewal and stem cell regeneration milestones
- **Start/stop controls** to manage your fast with a single tap
- **Hydration tracking** including “Drink Water” logging and reminder scheduling
- **Motivational messaging** that adapts to your current fasting phase
- **Mobile-first PWA UI** with progress visuals and offline caching support
- **Circle Sparks social layer** for sharing fasting progress, nudging friends, and playful check-ins
- **Dedicated refeeding guidance** so you can break extended fasts safely and intentionally
- **Quick feature buttons** for jumping to hydration, timeline, circle, and refeeding tools

## Project Structure
- `Code.gs` – Apps Script backend for fasting logic, hydration reminders, and data storage
- `index.html` – Frontend user interface served by HtmlService
- `service-worker.js` – Lightweight cache for progressive web app behavior
- `manifest.json` – Manifest metadata for installable experience
- `Agents.md` – Role definitions for the product team

## Setup
1. Open [Google Apps Script](https://script.google.com) and create a new project.
2. Add files matching this repository (`Code.gs`, `index.html`, `service-worker.js`, `manifest.json`, `Agents.md`).
3. Paste the contents from this repo into the respective files.
4. Deploy the project as a web app (`Deploy > New deployment > Web app`) and set access to **Anyone** or your preferred audience.
5. Open the deployment URL on your mobile device and add it to your home screen for an app-like experience.
6. The app serves the manifest and service worker via `?resource=` routes automatically—no extra routing configuration is required.

## Hydration Reminders
- Reminders are sent via email using Apps Script triggers. Adjust the interval in the app interface.
- To enable reminders, authorize the script when prompted and ensure email access is granted.
- The script automatically manages triggers when you start or stop a fast.

## Circle Sparks
- Share the auto-generated invite code with friends to join your accountability circle.
- Send **waves** for playful nudges, fire a **circle pulse** to ask everyone if they are still fasting, or **pulse check** individual friends for quick status updates.
- The activity feed highlights who replied, who needs a reminder, and when hydration wins happen—keeping the experience light, social, and addictive.

## Future Enhancements
- Push notifications using browser APIs
- Streak tracking and celebratory milestones
- Google Fit integration for hydration and activity insights
