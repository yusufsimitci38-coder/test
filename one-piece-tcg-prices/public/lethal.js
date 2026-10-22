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
// from hidden information - specifically what a generic un-Banished
// Trigger would actually do. Likewise the "% of DON!! allocations are
// lethal" figure is a coverage stat over the splits a player could choose,
// not a real probability.
//
// Color-specific Counter Events: a Counter Event is a card played from
// hand for an effect, instead of (or alongside) a printed Counter value -
// each one below is a SEPARATE resource from the generic 1000/2000-value
// cards already averaged into the budget above, with its own hand-card
// (and sometimes DON!!) cost:
//   - Universal (every color): 1 hand card + 1 DON!! for +4000 power.
//     Bounded by however many such cards are assumed in the deck AND by
//     DON!! actually available AND by having a hand card to spare.
//   - Red only: 2 hand cards (the event, plus discarding another card) for
//     +3000 power, no DON!! needed.
//   - Yellow only: NOT a Counter Event - a specific Trigger variant. When
//     one of these Life cards is dealt as damage, it's played instead of
//     added to hand (so it doesn't feed the hand-growth mechanic above),
//     and the defender may discard 1 hand card to add 1 card from the top
//     of their deck to their Life area - i.e. heal 1 Life. Estimated as
//     (current Life × assumed count ÷ deck size), since Life cards are
//     just the top of the same shuffled deck, capped by hand size.
// All of this is read in readDefenderContext(), which spends hand cards on
// these Events first (before the generic average-value budget), and feeds
// the result into defenderCanSurvive() as a bigger starting Counter budget
// (events) and/or a higher Life threshold to clear (Yellow's heal). Hand
// cards spent on Yellow's heal are capped by hand size but NOT jointly
// optimized against the Events above - a deliberate simplification, since
// exactly solving "Counter now vs. heal later" per battle would need a
// much larger search; this tends to slightly OVERESTIMATE total defense,
// which is the safer direction for a lethal calculator to be wrong in.
//
// Deliberately NOT modeled: Purple's Slow Slow Beam (2 DON!!, +2000
// Counter, rests an enemy Character) - unlike every Counter Event above,
// resting a Character can cancel a LATER attack in the line outright
// rather than add defensive power to the current one, which doesn't fit
// this model's "battles are fixed, only their Counter outcome is searched"
// shape. Dual-color Leaders get both colors' Events, but no deeper
// two-color interactions are modeled.
//
// Blue and Black have no color-specific mechanic to model: Blue's larger
// boards and heavier Blocker count are already captured by however many
// rows the user adds to Active Blockers, not something this calculator
// needs to assume on its own. Green is the same for now - a Leader
// releasing in about a month is expected to let certain cards count as
// 3000 Counter, but it isn't in the game yet, so there's nothing to add
// until it releases.

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

  const defLeaderColorInput = document.getElementById('def-leader-color');
  const defLeaderColor2Input = document.getElementById('def-leader-color-2');
  const defDonAvailableInput = document.getElementById('def-don-available');

  const handSizeInput = document.getElementById('def-hand-size');
  const counter2000Input = document.getElementById('def-counter-2000-count');
  const counter1000Input = document.getElementById('def-counter-1000-count');
  const deckSizeInput = document.getElementById('def-deck-size');
  const counterBudgetPreview = document.getElementById('counter-budget-preview');

  const universalEventCountInput = document.getElementById('def-universal-event-count');
  const redEventCountInput = document.getElementById('def-red-event-count');
  const yellowHealCountInput = document.getElementById('def-yellow-heal-count');

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

  // Averages the opponent's generic deck composition into an assumed
  // Counter value per card. This is the baseline 1000/2000-value-card
  // estimate only - Counter Events (universal/Red/Yellow) are separate
  // resources layered on top in readDefenderContext() below.
  function computeCounterBudget() {
    const handSize = Math.max(0, Math.floor(Number(handSizeInput.value)) || 0);
    const n2000 = Math.max(0, Number(counter2000Input.value)) || 0;
    const n1000 = Math.max(0, Number(counter1000Input.value)) || 0;
    const deckSize = Math.max(1, Number(deckSizeInput.value) || 1);
    const avgPerCard = (2000 * n2000 + 1000 * n1000) / deckSize;
    return { handSize, avgPerCard, deckSize };
  }

  function updateCounterBudgetPreview() {
    const defender = readDefenderContext();
    const extras = [];
    if (defender.universalUses) {
      extras.push(`${defender.universalUses} DON!! Counter Event${defender.universalUses === 1 ? '' : 's'}`);
    }
    if (defender.redUses) {
      extras.push(`${defender.redUses} 0-cost discard Event${defender.redUses === 1 ? '' : 's'}`);
    }
    const extrasText = extras.length ? `, plus ${extras.join(' and ')}` : '';
    let text =
      `≈${Math.round(defender.avgPerCard).toLocaleString()} Counter per card in hand → assumed Counter budget ` +
      `this turn: ~${Math.round(defender.counterBudget).toLocaleString()} from ${defender.handSize} hand ` +
      `card${defender.handSize === 1 ? '' : 's'}${extrasText}.`;
    if (defender.healUses) {
      text +=
        ` Plus ~${defender.healUses} assumed heal${defender.healUses === 1 ? '' : 's'} this turn (Yellow), ` +
        `raising their effective Life to ${defender.effectiveStartingLife}.`;
    }
    counterBudgetPreview.textContent = text;
  }

  // Bundles every "what do we know/assume about the opponent" into one
  // object, so resolveLine() and defenderCanSurvive() have a single, stable
  // place to read from - including the color-specific Counter Events (see
  // the header comment for the exact mechanics and the simplifications
  // involved). Hand cards are spent on Events first (universal, then Red),
  // and whatever's left funds the generic average-value Counter budget;
  // Yellow's heal is capped by hand size but tracked independently of that
  // spend - a documented, deliberately conservative simplification.
  function readDefenderContext() {
    const { avgPerCard, handSize, deckSize } = computeCounterBudget();
    const startingLife = Math.max(0, Number(defLifeInput.value) || 0);
    const color = defLeaderColorInput.value;
    const secondaryColor = defLeaderColor2Input.value || null;
    const donAvailable = Math.max(0, Math.floor(Number(defDonAvailableInput.value)) || 0);
    const universalEventCount = Math.max(0, Math.floor(Number(universalEventCountInput.value)) || 0);
    const redEventCount = Math.max(0, Math.floor(Number(redEventCountInput.value)) || 0);
    const yellowHealCount = Math.max(0, Math.floor(Number(yellowHealCountInput.value)) || 0);
    const hasColor = (c) => color === c || secondaryColor === c;

    const universalUses = Math.min(universalEventCount, donAvailable, handSize);
    const handAfterUniversal = Math.max(0, handSize - universalUses);
    const redUses = hasColor('red') ? Math.min(redEventCount, Math.floor(handAfterUniversal / 2)) : 0;
    const eventPower = universalUses * 4000 + redUses * 3000;

    const healUses = hasColor('yellow')
      ? Math.min(handSize, Math.round((startingLife * yellowHealCount) / deckSize))
      : 0;

    const handForGenericCounter = Math.max(0, handSize - universalUses - redUses * 2);
    const counterBudget = avgPerCard * handForGenericCounter + eventPower;
    const counterBudgetUnits = Math.round(counterBudget / 1000);

    return {
      leaderPower: Number(defLeaderPowerInput.value) || 0,
      startingLife,
      effectiveStartingLife: startingLife + healUses,
      color,
      secondaryColor,
      donAvailable,
      counterBudget,
      counterBudgetUnits,
      avgPerCard,
      handSize,
      universalUses,
      redUses,
      healUses,
    };
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
  function resolveLine(attackers, donAssignment, blockers, defender) {
    const blockersById = new Map(blockers.map((b) => [b.id, b]));
    const usedBlockerIds = new Set();
    const log = [];
    const leaderBattles = [];
    let life = defender.startingLife;
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
          // Counter Events (universal/Red/Yellow) don't apply here: they're
          // all spent during the Counter step of a Leader-direct battle in
          // defenderCanSurvive() - Blocker battles never affect Life in
          // this tool regardless of outcome, so Counter spent on one was
          // never meaningful here to begin with (same reasoning as plain
          // Counter above it).
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

      // Color-specific Counter Events (universal/Red) add power here too,
      // but as part of the shared Counter budget evaluated per-battle in
      // defenderCanSurvive() rather than a static boost to defPower itself
      // - see the header comment.
      const defPower = defender.leaderPower;
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
  //
  // defender.counterBudget already includes color-specific Counter Event
  // power (universal + Red) via readDefenderContext(), and
  // defender.effectiveStartingLife already includes Yellow's assumed heal
  // uses - this function doesn't need to know about color/DON!! directly,
  // just these two pre-computed numbers.
  function defenderCanSurvive(leaderBattles, defender) {
    const { effectiveStartingLife, counterBudget, avgPerCard } = defender;
    const totalHits = leaderBattles.reduce((sum, b) => sum + b.hits, 0);
    if (totalHits <= effectiveStartingLife) return true; // not even lethal before Counter is considered

    let dp = new Array(totalHits + 1).fill(-Infinity);
    dp[0] = counterBudget;

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

    for (let h = 0; h <= Math.min(effectiveStartingLife, totalHits); h += 1) {
      if (dp[h] !== -Infinity) return true;
    }
    return false;
  }

  function calculate() {
    const defender = readDefenderContext();
    const totalDon = Math.max(0, Math.floor(Number(donPoolInput.value)) || 0);
    const blockers = currentBlockers();

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
      const { log, lethal, finalLife, leaderBattles } = resolveLine(attackers, donAssignment, blockers, defender);
      const donUsed = donAssignment.reduce((sum, x) => sum + x, 0);

      let category = 'not-lethal';
      if (lethal) {
        const survives = defenderCanSurvive(leaderBattles, defender);
        category = survives ? 'soft-lethal' : 'robust-lethal';
      }

      return { donAssignment, donUsed, lethal, finalLife, log, category };
    });

    renderSearchResult({ attackers, results, totalDon, truncated, defender });
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

  function renderSearchResult({ attackers, results, totalDon, truncated, defender }) {
    resultEl.hidden = false;

    const exploredCount = results.length;
    const robust = results.filter((r) => r.category === 'robust-lethal').sort((a, b) => a.donUsed - b.donUsed);
    const soft = results.filter((r) => r.category === 'soft-lethal').sort((a, b) => a.donUsed - b.donUsed);
    const lethalCount = robust.length + soft.length;
    const pct = exploredCount ? Math.round((lethalCount / exploredCount) * 100) : 0;

    resultEl.classList.remove('lethal-result-yes', 'lethal-result-caution', 'lethal-result-no');
    resultEl.classList.add(robust.length ? 'lethal-result-yes' : soft.length ? 'lethal-result-caution' : 'lethal-result-no');

    const eventParts = [];
    if (defender.universalUses) eventParts.push(`${defender.universalUses} DON!! Counter Event${defender.universalUses === 1 ? '' : 's'}`);
    if (defender.redUses) eventParts.push(`${defender.redUses} 0-cost discard Event${defender.redUses === 1 ? '' : 's'}`);
    const eventsText = eventParts.length ? `, plus ${eventParts.join(' and ')}` : '';
    const healText = defender.healUses
      ? ` and ~${defender.healUses} assumed heal${defender.healUses === 1 ? '' : 's'} (raising their effective Life to ${defender.effectiveStartingLife})`
      : '';
    const budgetNote = `<p class="lethal-hint">Assuming the opponent has ~${Math.round(defender.counterBudget).toLocaleString()} Counter available this turn (~${defender.counterBudgetUnits.toLocaleString()}k, from their hand size and deck composition${eventsText})${healText}.</p>`;
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
  [
    handSizeInput,
    counter2000Input,
    counter1000Input,
    deckSizeInput,
    defLifeInput,
    defDonAvailableInput,
    universalEventCountInput,
    redEventCountInput,
    yellowHealCountInput,
  ].forEach((el) => el.addEventListener('input', updateCounterBudgetPreview));
  [defLeaderColorInput, defLeaderColor2Input].forEach((el) =>
    el.addEventListener('change', updateCounterBudgetPreview),
  );

  initLeaderRow();
  addBlockerRow();
  addAttackerRow();
  updateCounterBudgetPreview();
})();
