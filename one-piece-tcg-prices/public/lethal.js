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
// this turn, same as DON!!.
//
// Crucially, that budget isn't static through the turn: a Life card dealt
// as damage is added to the defender's hand unless it's Banished (official
// Q&A + printed [Banish] card text confirm this is unconditional otherwise -
// see the commit message for sources), and Counter has no "must have been
// in hand since the start of the turn" restriction, so a card gained from
// an EARLIER battle's damage this turn is immediately available to Counter
// a LATER battle in the same sequence. This calculator accounts for that:
// each non-Banished Leader hit that's allowed to connect grows the assumed
// budget (by the same per-card average) before the next battle is
// evaluated. For each DON!! split, it checks every order of
// negate-or-allow decisions across that line's Leader-targeted battles to
// see if ANY of them lets the defender survive within their (growing)
// budget, and reports whether the line is lethal even against that full
// budget ("robust") or only lethal if they come up short on Counter
// ("soft").
//
// NOT modeled yet (see the caveat text in index.html): true probability
// from hidden information - specifically what a given un-Banished Trigger
// would actually do. Likewise the "% of DON!! allocations are lethal"
// figure is a coverage stat over the splits a player could choose, not a
// real probability.

(function () {
  const MAX_DISTRIBUTIONS = 5000;
  const MAX_LINES_SHOWN = 10;

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
      const costPower = (Math.floor((effectivePower - defPower) / 1000) + 1) * 1000;
      leaderBattles.push({ hits, costPower, banish: attacker.banish });

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

  // Determines whether the defender can survive this line's Leader-targeted
  // battles using their assumed Counter budget, accounting for the budget
  // growing mid-turn from non-Banished Life cards reaching hand (see the
  // header comment for why that's rules-accurate). Each battle's Counter
  // spend is all-or-nothing: either enough is spent to fully negate it (no
  // hits, no hand gain from it), or none is spent and it connects in full
  // (hits count toward lethal, and - unless Banished - its Life card grows
  // the budget available for battles later in this same order).
  //
  // Solved with a DP over (battle index, hits allowed through so far) ->
  // the MAXIMUM achievable running budget for that state. A higher budget
  // can only ever help later decisions, so only the max per state needs to
  // be kept - this keeps the search polynomial (battles × total hits)
  // instead of exponential, even though the decisions are now sequential
  // (budget earned from one battle can't be spent on an earlier one).
  function defenderCanSurvive(leaderBattles, startingLife, initialBudget, avgPerCard) {
    const totalHits = leaderBattles.reduce((sum, b) => sum + b.hits, 0);
    if (totalHits <= startingLife) return true; // not even lethal before Counter is considered

    let dp = new Array(totalHits + 1).fill(-Infinity);
    dp[0] = initialBudget;

    for (const battle of leaderBattles) {
      const next = new Array(totalHits + 1).fill(-Infinity);
      for (let h = 0; h <= totalHits; h += 1) {
        const budget = dp[h];
        if (budget === -Infinity) continue;

        // Negate this battle: spend its cost now, no hits, no hand gain.
        if (budget >= battle.costPower && budget - battle.costPower > next[h]) {
          next[h] = budget - battle.costPower;
        }

        // Let it connect: hits count, and it grows the budget unless Banished.
        const nh = h + battle.hits;
        if (nh <= totalHits) {
          const gained = budget + (battle.banish ? 0 : battle.hits * avgPerCard);
          if (gained > next[nh]) next[nh] = gained;
        }
      }
      dp = next;
    }

    for (let h = 0; h <= Math.min(startingLife, totalHits); h += 1) {
      if (dp[h] !== -Infinity) return true;
    }
    return false;
  }

  function calculate() {
    const defenderLeaderPower = Number(defLeaderPowerInput.value) || 0;
    const startingLife = Math.max(0, Number(defLifeInput.value) || 0);
    const totalDon = Math.max(0, Math.floor(Number(donPoolInput.value)) || 0);
    const blockers = currentBlockers();
    const { totalAssumed, budgetUnits, avgPerCard } = computeCounterBudget();

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
      if (lethal) {
        const survives = defenderCanSurvive(leaderBattles, startingLife, totalAssumed, avgPerCard);
        category = survives ? 'soft-lethal' : 'robust-lethal';
      }

      return { donAssignment, donUsed, lethal, finalLife, log, category };
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
        <p class="lethal-hint">Even their full assumed Counter budget can't stop this line - including any Life cards they'd add to hand from earlier hits in this same sequence.</p>
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
        <p class="lethal-hint">The opponent can survive this - starting from their assumed budget above, and counting any Life cards they'd add to hand from earlier hits in this same sequence.</p>
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
