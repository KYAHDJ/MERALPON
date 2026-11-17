# Meralpon

A simple electricity tracker. Log your meter readings, see daily usage, and get an estimate of your next bill.

**Live:** https://kyahdj.github.io/MERALPON/

## Features
- Estimated bill, billing-period progress and tomorrow's forecast
- Meter readings by typing or by photo (reads the digits in your browser)
- Daily usage chart, spike notice, and past bills
- Private account with email confirmation; works as a home-screen app on phones
- Backups as JSON or spreadsheet

## Run it locally
```bash
pnpm install
pnpm dev
```
Build with `pnpm build`. Pushing to `main` deploys to GitHub Pages.

Built with React, Vite, Tailwind CSS and Firebase. Meralpon is an independent project and is not an official Meralco service.
