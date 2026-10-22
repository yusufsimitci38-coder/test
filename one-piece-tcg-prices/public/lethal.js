// Lethal Calculator - deterministic combat-math tool for the One Piece
// Card Game. Entirely client-side: no server round-trip, nothing persisted,
// since the point is "plan this turn's attacks right now," not data that
// needs tracking over time (unlike the Price/Event trackers elsewhere in
// this app).
//
// Rules this encodes (confirmed against the official Comprehensive Rules
// and corroborating community guides, since this sandbox can't fetch
// en.onepiece-cardgame.com directly - see the commit message for sources):
//   - Battle: attacker power >= defender power wins (ties go to the
//     attacker); the attacker is never penalized for losing a battle.
//   - Blocker: must be active to block, redirects one attack fully away
//     from the Leader, and can only block once per turn - declaring block
//     uses it up for the turn whether the attacker wins or loses.
//   - DON!!: each attached DON gives +1000 power, for the turn only.
//   - Double Attack: NOT "2x power" - it deals damage as two separate
//     Life-card hits, each its own reveal/Trigger opportunity.
//   - Banish: the Life card removed goes straight to the trash, unseen -
//     no Trigger, ever, for that hit specifically.
//   - Loss condition: reaching 0 Life isn't itself a loss - the player
//     loses when they take a successful hit WHILE ALREADY at 0 Life.
//
// DON!! allocation search: rather than asking the user to fix a DON amount
// per attacker and re-run one scenario at a time, they enter a total DON!!
// pool and (optionally) a per-attacker cap, and this enumerates every valid
// way to split the pool across attackers (attack order/targets are fixed as
// configured), runs the combat simulation on each split, and reports which
// splits are lethal. Target/order choices are NOT searched - only the DON!!
// split is - to keep the search space bounded and the result legible.
//
// Assumed Counter budget: rather than a manual "counter here" guess typed
// per attack, the opponent's hand size and deck's Counter-card composition
// (how many 1000s and 2000s it runs) are averaged into one total Counter
// budget for the turn. Counter is only relevant to attacks that target the
// Leader directly - defending a Blocker never costs or saves Life in this
// model, so it isn't considered there. Since a Counter card is discarded
// once played, that budget is a shared pool spent across every Leader hit
// this turn, same as DON!!: for each DON!! split, this finds the cheapest
// way (in assumed Counter) the opponent could spend that budget to survive,
// and reports whether the line is lethal even against their FULL budget
// ("robust") or only lethal if they come up short on Counter ("soft").
//
// NOT modeled yet (see the caveat text in index.html): true probability
// from hidden information - specifically what a given un-Banished Trigger
// would actually do. Likewise the "% of DON!! allocations are lethal"
// figure is a coverage stat over the splits a player could choose, not a
// real probability.

(function () {
  const MAX_DISTRIBUTIONS = 5000;
  const MAX_LINES_SHOWN = 10;
  const MAX_KNAPSACK_ITEMS = 16; // brute-force subset search stays fast below this

  const blockersList = document.getElementById('def-blockers-list');
  const addBlockerBtn = document.getElementById('def-add-blocker');
  const blockerTemplate = document.getElementById('lethal-blocker-template');

  const leaderRowContainer = document.getElementById('atk-leader-row-container');
  const leaderTemplate = document.getElementById('lethal-leader-template');

  const attackersList = document.getElementById('atk-characters-list');
  const addAttackerBtn = document.getElementById('atk-add-character');
  const attackerTemplate = document.getElementById('lethal-attacker-template');

  const defLeaderPowerInput = document.getElementById('def-leader-power');
  const defLifeInput = document.getElementById('def-life');
  const donPoolInput = document.getElementById('atk-don-pool');

  const handSizeInput = document.getElementById('def-hand-size');
  const counter2000Input = document.getElementById('def-counter-2000-count');
  const counter1000Input = document.getElementById('def-counter-1000-count');
  const deckSizeInput = document.getElementById('def-deck-size');
  const counterBudgetPreview = document.getElementById('counter-budget-preview');

  const calculateBtn = document.getElementById('calculate-lethal-btn');
  const resultEl = document.getElementById('lethal-result');

  let nextBlockerId = 1;

  function addBlockerRow() {
    const node = blockerTemplate.content.cloneNode(true);
    const row = node.querySelector('.lethal-blocker-row');
    row.dataset.blockerId = String(nextBlockerId++);
    row.querySelector('.lethal-blocker-name').addEventListener('input', refreshTargetOptions);
    row.querySelector('.lethal-remove-btn').addEventListener('click', () => {
      row.remove();
      refreshTargetOptions();
    });
    blockersList.appendChild(row);
    refreshTargetOptions();
  }

  function currentBlockers() {
    return [...blockersList.querySelectorAll('.lethal-blocker-row')].map((row, index) => ({
      id: row.dataset.blockerId,
      name: row.querySelector('.lethal-blocker-name').value.trim() || `Blocker ${index + 1}`,
      power: Number(row.querySelector('.lethal-blocker-power').value) || 0,
    }));
  }

  // Rebuilds every attacker row's Target dropdown from the current blocker
  // list, preserving each row's selection when that blocker still exists -
  // falling back to "Opponent Leader (direct)" when it was removed/renamed
  // out from under it.
  function refreshTargetOptions() {
    const blockers = currentBlockers();
    const selects = document.querySelectorAll('.lethal-atk-target');
    selects.forEach((select) => {
      const previousValue = select.value;
      select.innerHTML = '<option value="leader">Opponent Leader (direct)</option>';
      for (const b of blockers) {
        const opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = `Block: ${b.name} (${b.power})`;
        select.appendChild(opt);
      }
      if ([...select.options].some((o) => o.value === previousValue)) {
        select.value = previousValue;
      }
    });
  }

  function addAttackerRow() {
    const node = attackerTemplate.content.cloneNode(true);
    const row = node.querySelector('.lethal-attacker-row');
    row.querySelector('.lethal-remove-btn').addEventListener('click', () => row.remove());
    row.querySelector('.lethal-move-up').addEventListener('click', () => {
      const prev = row.previousElementSibling;
      if (prev) attackersList.insertBefore(row, prev);
    });
    row.querySelector('.lethal-move-down').addEventListener('click', () => {
      const next = row.nextElementSibling;
      if (next) attackersList.insertBefore(next, row);
    });
    attackersList.appendChild(row);
    refreshTargetOptions();
  }

  function initLeaderRow() {
    const node = leaderTemplate.content.cloneNode(true);
    leaderRowContainer.appendChild(node);
    refreshTargetOptions();
  }

  function readAttackerRow(row, isLeader) {
    const donCapRaw = row.querySelector('.lethal-atk-don').value.trim();
    const donCap = donCapRaw === '' ? Infinity : Math.max(0, Math.floor(Number(donCapRaw)) || 0);
    return {
      isLeader,
      name: isLeader ? 'Your Leader' : row.querySelector('.lethal-atk-name')?.value.trim() || 'Character',
      attacksThisTurn: isLeader ? row.querySelector('.lethal-atk-attacks').checked : true,
      power: Number(row.querySelector('.lethal-atk-power').value) || 0,
      donCap,
      double: row.querySelector('.lethal-atk-double').checked,
      banish: row.querySelector('.lethal-atk-banish').checked,
      target: row.querySelector('.lethal-atk-target').value,
    };
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Averages the opponent's deck composition into an assumed Counter value
  // per card, then multiplies by hand size for a total budget this turn.
  // budgetUnits rounds that total to the nearest 1000 (Counter cards only
  // come in 1000/2000 increments, so the search below works in those units).
  function computeCounterBudget() {
    const handSize = Math.max(0, Math.floor(Number(handSizeInput.value)) || 0);
    const n2000 = Math.max(0, Number(counter2000Input.value)) || 0;
    const n1000 = Math.max(0, Number(counter1000Input.value)) || 0;
    const deckSize = Math.max(1, Number(deckSizeInput.value) || 1);
    const avgPerCard = (2000 * n2000 + 1000 * n1000) / deckSize;
    const totalAssumed = avgPerCard * handSize;
    const budgetUnits = Math.round(totalAssumed / 1000);
    return { handSize, avgPerCard, totalAssumed, budgetUnits };
  }

  function updateCounterBudgetPreview() {
    const { handSize, avgPerCard, totalAssumed } = computeCounterBudget();
    counterBudgetPreview.textContent =
      `≈${Math.round(avgPerCard).toLocaleString()} Counter per card in hand → assumed Counter budget this turn: ` +
      `~${Math.round(totalAssumed).toLocaleString()} across ${handSize} card${handSize === 1 ? '' : 's'}.`;
  }

  // Enumerates every way to assign non-negative integer DON!! amounts to
  // `caps.length` attackers such that each amount is <= that attacker's cap
  // and the total used is <= `total` (unused DON!! is implicitly allowed -
  // it just sits in that distribution's "leftover"). Stops early past
  // `maxCount` results and reports truncation rather than hanging on a huge
  // pool/attacker-count combination.
  function enumerateDonDistributions(caps, total, maxCount) {
    const distributions = [];
    let truncated = false;

    function recurse(index, remaining, current) {
      if (truncated) return;
      if (index === caps.length) {
        distributions.push(current.slice());
        if (distributions.length >= maxCount) truncated = true;
        return;
      }
      const maxHere = Math.min(caps[index], remaining);
      for (let x = 0; x <= maxHere; x += 1) {
        current.push(x);
        recurse(index + 1, remaining - x, current);
        current.pop();
        if (truncated) return;
      }
    }

    recurse(0, total, []);
    return { distributions, truncated };
  }

  // Runs the combat resolution for one specific DON!! split across
  // `attackers` (parallel array `donAssignment`), in list order, against the
  // fixed defender board - assuming the opponent plays NO Counter. Returns
  // the play-by-play log, the base lethal/finalLife outcome, and the list of
  // Leader-targeted battles (with their hit count and the Counter cost to
  // negate each one) for the Counter-feasibility search below. Processes
  // every attacker (doesn't stop at the first lethal hit) so that search has
  // the full picture of what's negatable.
  function resolveLine(attackers, donAssignment, blockers, defenderLeaderPower, startingLife) {
    const blockersById = new Map(blockers.map((b) => [b.id, b]));
    const usedBlockerIds = new Set();
    const log = [];
    const leaderBattles = [];
    let life = startingLife;
    let lethal = false;

    for (let i = 0; i < attackers.length; i += 1) {
      const attacker = attackers[i];
      const donAssigned = donAssignment[i];
      const effectivePower = attacker.power + donAssigned * 1000;
      const donNote = donAssigned ? ` (+${donAssigned} DON)` : '';
      let target = attacker.target;

      if (target !== 'leader') {
        const blocker = blockersById.get(target);
        if (!blocker) {
          target = 'leader'; // blocker row was removed after this row was set up
        } else if (usedBlockerIds.has(blocker.id)) {
          log.push({
            type: 'note',
            text: `${attacker.name}${donNote} was set to be blocked by ${blocker.name}, but that Blocker was already used earlier this turn - attacking the Leader directly instead.`,
          });
          target = 'leader';
        } else {
          usedBlockerIds.add(blocker.id); // declaring block uses it up whether this battle is won or lost
          const defPower = blocker.power;
          if (effectivePower >= defPower) {
            log.push({
              type: 'ko',
              text: `${attacker.name}${donNote} (${effectivePower.toLocaleString()}) K.O.'s ${blocker.name} (${defPower.toLocaleString()}). No Life lost.`,
            });
          } else {
            log.push({
              type: 'fail',
              text: `${attacker.name}${donNote} (${effectivePower.toLocaleString()}) doesn't get through ${blocker.name} (${defPower.toLocaleString()}). No Life lost.`,
            });
          }
          continue;
        }
      }

      const defPower = defenderLeaderPower;
      if (effectivePower < defPower) {
        log.push({
          type: 'fail',
          text: `${attacker.name}${donNote} (${effectivePower.toLocaleString()}) doesn't get through the Leader (${defPower.toLocaleString()}). No Life lost.`,
        });
        continue;
      }

      const hits = attacker.double ? 2 : 1;
      const costUnits = Math.floor((effectivePower - defPower) / 1000) + 1;
      leaderBattles.push({ hits, costUnits });

      for (let h = 0; h < hits; h += 1) {
        if (life <= 0) {
          if (!lethal) {
            lethal = true;
            log.push({ type: 'lethal', text: `${attacker.name} hits the Leader while Life is already 0 - LETHAL.` });
          } else {
            log.push({ type: 'note', text: `${attacker.name} also connects, but the game is already over by this point.` });
          }
        } else {
          life -= 1;
          const banishNote = attacker.banish ? 'Banished - no Trigger' : 'revealed - Trigger may activate';
          log.push({
            type: 'hit',
            text: `${attacker.name}${donNote} hits the Leader (${effectivePower.toLocaleString()} vs ${defPower.toLocaleString()}). Life card removed (${banishNote}). Life now ${life}.`,
          });
        }
      }
    }

    return { log, lethal, finalLife: life, leaderBattles };
  }

  // Finds the minimum Counter (in 1000-units) the opponent needs to spend to
  // survive: each Leader-targeted battle is an all-or-nothing item (pay its
  // cost to fully negate that battle's hits, or pay nothing and take them
  // all), so this is a small 0/1 knapsack - brute-forced since there are
  // normally only a handful of Leader-targeted battles per turn. Returns
  // null if the line isn't lethal in the first place (no Counter needed).
  function minCounterCostToSurvive(leaderBattles, startingLife) {
    const totalHits = leaderBattles.reduce((sum, b) => sum + b.hits, 0);
    if (totalHits <= startingLife) return null;
    const requiredReduction = totalHits - startingLife;
    const n = leaderBattles.length;

    if (n > MAX_KNAPSACK_ITEMS) {
      // Unusually large attacker count - fall back to a greedy approximation
      // (best hits-per-cost first) rather than a combinatorial blow-up.
      const sorted = leaderBattles.slice().sort((a, b) => b.hits / b.costUnits - a.hits / a.costUnits);
      let hits = 0;
      let cost = 0;
      for (const b of sorted) {
        if (hits >= requiredReduction) break;
        hits += b.hits;
        cost += b.costUnits;
      }
      return cost;
    }

    let best = Infinity;
    const combos = 1 << n;
    for (let mask = 0; mask < combos; mask += 1) {
      let hits = 0;
      let cost = 0;
      for (let i = 0; i < n; i += 1) {
        if (mask & (1 << i)) {
          hits += leaderBattles[i].hits;
          cost += leaderBattles[i].costUnits;
        }
      }
      if (hits >= requiredReduction && cost < best) best = cost;
    }
    return best;
  }

  function calculate() {
    const defenderLeaderPower = Number(defLeaderPowerInput.value) || 0;
    const startingLife = Math.max(0, Number(defLifeInput.value) || 0);
    const totalDon = Math.max(0, Math.floor(Number(donPoolInput.value)) || 0);
    const blockers = currentBlockers();
    const { totalAssumed, budgetUnits } = computeCounterBudget();

    const attackers = [
      readAttackerRow(leaderRowContainer.querySelector('.lethal-attacker-row'), true),
      ...[...attackersList.querySelectorAll('.lethal-attacker-row')].map((row) => readAttackerRow(row, false)),
    ].filter((a) => a.attacksThisTurn);

    if (!attackers.length) {
      resultEl.hidden = false;
      resultEl.classList.remove('lethal-result-yes', 'lethal-result-caution');
      resultEl.classList.add('lethal-result-no');
      resultEl.innerHTML = '<h2>No attackers are set to attack this turn.</h2>';
      resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    const caps = attackers.map((a) => Math.min(a.donCap, totalDon));
    const { distributions, truncated } = enumerateDonDistributions(caps, totalDon, MAX_DISTRIBUTIONS);

    const results = distributions.map((donAssignment) => {
      const { log, lethal, finalLife, leaderBattles } = resolveLine(
        attackers,
        donAssignment,
        blockers,
        defenderLeaderPower,
        startingLife,
      );
      const donUsed = donAssignment.reduce((sum, x) => sum + x, 0);

      let category = 'not-lethal';
      let counterCostNeeded = null;
      if (lethal) {
        const minCost = minCounterCostToSurvive(leaderBattles, startingLife);
        if (minCost !== null && minCost <= budgetUnits) {
          category = 'soft-lethal';
          counterCostNeeded = minCost;
        } else {
          category = 'robust-lethal';
        }
      }

      return { donAssignment, donUsed, lethal, finalLife, log, category, counterCostNeeded };
    });

    renderSearchResult({
      attackers,
      results,
      totalDon,
      truncated,
      counterBudgetUnits: budgetUnits,
      totalAssumedCounter: totalAssumed,
    });
  }

  function renderLine(attackers, result, totalDon) {
    const allocText = attackers.map((a, i) => `${escapeHtml(a.name)}: ${result.donAssignment[i]}`).join(', ');
    const logHtml = result.log.length
      ? `<ul class="lethal-log">${result.log.map((entry) => `<li class="lethal-log-${entry.type}">${escapeHtml(entry.text)}</li>`).join('')}</ul>`
      : '<p class="empty-state">No attacks landed.</p>';
    return `
      <div class="lethal-line">
        <p class="lethal-line-alloc"><strong>DON!! used (${result.donUsed} of ${totalDon}):</strong> ${allocText}</p>
        ${logHtml}
      </div>
    `;
  }

  function renderSearchResult({ attackers, results, totalDon, truncated, counterBudgetUnits, totalAssumedCounter }) {
    resultEl.hidden = false;

    const exploredCount = results.length;
    const robust = results.filter((r) => r.category === 'robust-lethal').sort((a, b) => a.donUsed - b.donUsed);
    const soft = results.filter((r) => r.category === 'soft-lethal').sort((a, b) => a.donUsed - b.donUsed);
    const lethalCount = robust.length + soft.length;
    const pct = exploredCount ? Math.round((lethalCount / exploredCount) * 100) : 0;

    resultEl.classList.remove('lethal-result-yes', 'lethal-result-caution', 'lethal-result-no');
    resultEl.classList.add(robust.length ? 'lethal-result-yes' : soft.length ? 'lethal-result-caution' : 'lethal-result-no');

    const budgetNote = `<p class="lethal-hint">Assuming the opponent has ~${Math.round(totalAssumedCounter).toLocaleString()} Counter available this turn (~${counterBudgetUnits.toLocaleString()}k, from their hand size and deck composition).</p>`;
    const truncNote = truncated
      ? `<p class="lethal-hint">Search capped at ${exploredCount.toLocaleString()} DON!! allocations explored (your pool/attacker count allows more) - showing the best results found within that limit.</p>`
      : '';

    if (robust.length) {
      const cheapest = robust[0];
      const others = robust.slice(1, MAX_LINES_SHOWN);
      const softNote = soft.length
        ? ` (plus ${soft.length.toLocaleString()} more that only connect if they're short on Counter)`
        : '';
      resultEl.innerHTML = `
        <h2>☠️ Lethal even against their assumed Counter — ${robust.length.toLocaleString()} of ${exploredCount.toLocaleString()} DON!! allocations explored are robustly lethal (${pct}% lethal overall${softNote})</h2>
        ${budgetNote}
        ${truncNote}
        <h3>Recommended line — uses fewest DON!! (${cheapest.donUsed} of ${totalDon})</h3>
        ${renderLine(attackers, cheapest, totalDon)}
        <p class="lethal-hint">Even their full assumed Counter budget can't stop this line.</p>
        ${
          others.length
            ? `<h3>Other robustly lethal lines found</h3><div class="lethal-lines-list">${others
                .map((r) => renderLine(attackers, r, totalDon))
                .join('')}</div>`
            : ''
        }
      `;
      resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    if (soft.length) {
      const cheapest = soft[0];
      const others = soft.slice(1, MAX_LINES_SHOWN);
      resultEl.innerHTML = `
        <h2>⚠️ Lethal only if they're short on Counter — ${soft.length.toLocaleString()} of ${exploredCount.toLocaleString()} DON!! allocations explored connect, but their assumed budget can survive every one (${pct}%)</h2>
        ${budgetNote}
        ${truncNote}
        <h3>Cheapest connecting line (${cheapest.donUsed} of ${totalDon} DON!!)</h3>
        ${renderLine(attackers, cheapest, totalDon)}
        <p class="lethal-hint">The opponent can survive this by spending ~${cheapest.counterCostNeeded.toLocaleString()}k Counter (within their assumed ~${counterBudgetUnits.toLocaleString()}k budget).</p>
        ${
          others.length
            ? `<h3>Other connecting lines found</h3><div class="lethal-lines-list">${others
                .map((r) => renderLine(attackers, r, totalDon))
                .join('')}</div>`
            : ''
        }
      `;
      resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    const best = results.slice().sort((a, b) => a.finalLife - b.finalLife || b.donUsed - a.donUsed)[0];
    resultEl.innerHTML = `
      <h2>Not lethal — 0 of ${exploredCount.toLocaleString()} DON!! allocations explored connect for lethal (0%)</h2>
      ${budgetNote}
      ${truncNote}
      <h3>Closest line found</h3>
      ${renderLine(attackers, best, totalDon)}
    `;
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  addBlockerBtn.addEventListener('click', addBlockerRow);
  addAttackerBtn.addEventListener('click', addAttackerRow);
  calculateBtn.addEventListener('click', calculate);
  [handSizeInput, counter2000Input, counter1000Input, deckSizeInput].forEach((el) =>
    el.addEventListener('input', updateCounterBudgetPreview),
  );

  initLeaderRow();
  addBlockerRow();
  addAttackerRow();
  updateCounterBudgetPreview();
})();
