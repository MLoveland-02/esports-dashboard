const https = require('https');
const fs = require('fs');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    };
    const req = https.get(url, options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getTodayDate() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return y + '/' + m + '/' + d;
}

const TARGET_LEAGUES = [
  'Conference League', 'FA Cup', 'Champions League B', 'Champions League A',
  'Bundesliga', 'Portugal Primera', 'Premier League', 'Europa League',
  'LaLiga', 'Serie A', 'Ligue 1', 'World Cup A', 'World Cup B',
  'International A', 'International B', 'Nations League', 'Copa Libertadores',
  'Club World Cup', 'Super Lig', 'K League', 'Argentina Super League', 'RSL'
];

async function getSchedule(date) {
  const tournaments = [];
  const dateStr = encodeURIComponent(date + ' 00:00');
  const dateTo = encodeURIComponent(date + ' 23:59');
  for (let page = 1; page <= 3; page++) {
    const url = 'https://football.esportsbattle.com/en/schedule?page=' + page + '&dateFrom=' + dateStr + '&dateTo=' + dateTo;
    try {
      const html = await fetchUrl(url);
      const linkRegex = /href=\"\/en\/tournament\/(\\d+)\"/g;
      let m;
      while ((m = linkRegex.exec(html)) !== null) {
        const id = m[1];
        if (!tournaments.find(t => t.id === id)) {
          const pos = m.index;
          const nearby = html.substring(Math.max(0, pos - 300), pos + 200);
          let leagueName = null;
          for (const league of TARGET_LEAGUES) {
            if (nearby.includes(league)) { leagueName = league; break; }
          }
          const timeMatch = nearby.match(/(\\d{4}\/\\d{2}\/\\d{2} \\d{2}:\\d{2})/);
          const time = timeMatch ? timeMatch[1].split(' ')[1] : null;
          const statusMatch = nearby.match(/Tournament (Finished|Started|Public)/);
          const status = statusMatch ? statusMatch[1] : 'Unknown';
          if (leagueName) {
            tournaments.push({ id, name: leagueName, time, status });
          }
        }
      }
    } catch(e) { console.error('Schedule p' + page + ':', e.message); }
    await sleep(600);
  }
  return tournaments;
}

async function getTournament(id) {
  const url = 'https://football.esportsbattle.com/en/tournament/' + id;
  const html = await fetchUrl(url);
  const data = { id, url, players: [], standings: [], matches: [], venue: null, group: null };

  // Title/group
  const titleMatch = html.match(/Tournament (?:Finished|Started|Public)([^,]+),([^,]+),([^<]+)/);
  if (titleMatch) {
    data.group = titleMatch[2].trim();
    data.venue = titleMatch[3].trim();
  }
  data.status = html.includes('Tournament Finished') ? 'Finished' :
                html.includes('Tournament Started') ? 'Started' : 'Upcoming';

  // Players
  const playerRegex = /href=\"\/en\/participants\/([^\"]+)\"/g;
  const seen = new Set();
  let pm;
  while ((pm = playerRegex.exec(html)) !== null) {
    const name = pm[1];
    if (!seen.has(name) && name.length > 1 && !name.includes('%') && !name.includes('/')) {
      seen.add(name);
      data.players.push(name);
    }
  }

  // Standings
  const blocks = html.split('Games Played:');
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    const gp = parseInt(b.match(/^(\\d+)/)?.[1] || '0');
    const w  = parseInt(b.match(/Win:(\\d+)/)?.[1] || '0');
    const d  = parseInt(b.match(/Draw:(\\d+)/)?.[1] || '0');
    const l  = parseInt(b.match(/Lose:(\\d+)/)?.[1] || '0');
    const gfga = b.match(/Goals For \/ Goals Against:(\\d+) - (\\d+)/);
    const pts = parseInt(b.match(/Points:(\\d+)/)?.[1] || '0');
    data.standings.push({ gp, w, d, l, gf: gfga?parseInt(gfga[1]):0, ga: gfga?parseInt(gfga[2]):0, pts });
  }

  // Match results
  const matchRegex = /Finished[\\s\\S]{0,100}?([A-Z][a-z][^<]{1,25})<[^>]+>([A-Z][a-z][^<]{1,25})<[^>]+>(\\d+)<[^>]+>(\\d+)/g;
  let mm;
  while ((mm = matchRegex.exec(html)) !== null) {
    data.matches.push({ home: mm[1].trim(), away: mm[2].trim(), hs: parseInt(mm[3]), as: parseInt(mm[4]) });
  }
  return data;
}

async function getPlayer(name) {
  const url = 'https://football.esportsbattle.com/en/participants/' + encodeURIComponent(name);
  try {
    const html = await fetchUrl(url);
    const country = html.match(/Country, City:\s*([^<,]+)/)?.[1]?.trim() || '';
    const age = parseInt(html.match(/Age:\s*(\\d+)/)?.[1] || '0');
    const tourn = parseInt(html.match(/All Tournaments:\s*(\\d+)/)?.[1] || '0');
    const matches = parseInt(html.match(/All Matches:\s*(\\d+)/)?.[1] || '0');
    const wins = parseInt(html.match(/Win:(\\d+)/)?.[1] || '0');
    const draws = parseInt(html.match(/Draw:(\\d+)/)?.[1] || '0');
    const losses = parseInt(html.match(/Lose:(\\d+)/)?.[1] || '0');

    // Recent tournament history
    const recent = [];
    const rBlocks = html.split('Tournament ');
    for (let i = 1; i < Math.min(rBlocks.length, 11); i++) {
      const b = rBlocks[i];
      const status = b.match(/^(Finished|Started|Public)/)?.[1];
      if (!status) continue;
      const nameMatch = b.match(/([A-Z][a-z][^\\n]{3,35} \\d{4}-\\d{2}-\\d{2})/);
      const teamMatch = b.match(/([A-Z][a-zA-Z ]{2,20})\\nPlace/);
      const place = parseInt(b.match(/Place(\\d+)/)?.[1] || '0');
      const rw = parseInt(b.match(/\\(W\\) Win:(\\d+)/)?.[1] || '0');
      const rd = parseInt(b.match(/\\(D\\) Draw:(\\d+)/)?.[1] || '0');
      const rl = parseInt(b.match(/\\(L\\) Lose:(\\d+)/)?.[1] || '0');
      if (nameMatch) {
        recent.push({ name: nameMatch[1].trim(), team: teamMatch?.[1]?.trim(), place, w: rw, d: rd, l: rl, status });
      }
    }

    const wr = matches > 0 ? (wins/matches*100).toFixed(1) : '0.0';
    const dr = matches > 0 ? (draws/matches*100).toFixed(1) : '0.0';
    const lr = matches > 0 ? (losses/matches*100).toFixed(1) : '0.0';
    return { name, country, age, tournaments: tourn, matches, wins, draws, losses, winRate: wr, drawRate: dr, lossRate: lr, recent };
  } catch(e) {
    return { name, error: e.message };
  }
}

async function main() {
  console.log('ESportsBattle scraper starting...');
  const date = getTodayDate();
  const output = { date, fetchedAt: new Date().toISOString(), tournaments: [], players: {} };

  const schedule = await getSchedule(date);
  console.log('Found', schedule.length, 'tournaments');

  for (const t of schedule) {
    console.log('Fetching tournament', t.id, t.name);
    try {
      const data = await getTournament(t.id);
      data.leagueName = t.name;
      data.time = t.time;
      output.tournaments.push(data);
      for (const p of data.players) {
        if (!output.players[p]) output.players[p] = null;
      }
    } catch(e) { console.error('Tournament error:', e.message); }
    await sleep(800);
  }

  const playerNames = Object.keys(output.players);
  console.log('Fetching', playerNames.length, 'players...');
  for (const name of playerNames) {
    console.log(' Player:', name);
    output.players[name] = await getPlayer(name);
    await sleep(500);
  }

  fs.writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log('Done. Tournaments:', output.tournaments.length, 'Players:', playerNames.length);
}

main().catch(console.error);
