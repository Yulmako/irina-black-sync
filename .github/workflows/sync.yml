name: Sync zapis.kz bookings into Supabase

on:
  schedule:
    # Every hour, on the hour (UTC). GitHub may delay this slightly during
    # busy periods, especially on the free plan — that's normal.
    - cron: '0 * * * *'
  workflow_dispatch: {} # lets you trigger a sync manually from the Actions tab

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Sync bookings into Supabase
        env:
          ZAPIS_COOKIE: ${{ secrets.ZAPIS_COOKIE }}
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
        run: node scripts/sync.js
