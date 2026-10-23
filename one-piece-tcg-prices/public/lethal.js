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
//     Life-card hits, each its own reveal/Trigger opportunity. Each hit
//     only takes a Life card if one is actually left - a Double Attack
//     landing against 1 Life takes that 1 card and stops there; it does
//     NOT defeat the opponent on its own (official ruling, Comprehensive
//     Rules FAQ, Double Attack 4-10/4-11: a Double Attack cannot win the
//     game against a 1-Life opponent). Defeat only comes from a hit that
//     lands WHILE ALREADY AT 0 Life - see "Loss condition" below - and
//     that can only be a SEPARATE, later battle, not the same Double
//     Attack's own second hit running out of cards to take.
//   - Banish: the Life card removed goes straight to the trash, unseen -
//     no Trigger, ever, for that hit specifically.
//   - Loss condition: reaching 0 Life isn't itself a loss - the player
//     loses when they take a successful hit WHILE ALREADY at 0 Life. This
//     is checked once per BATTLE, before that battle's damage is dealt -
//     not once per individual hit within a multi-hit battle - which is
//     exactly what makes the Double Attack rule above true, and why attack
//     ORDER affects whether a given set of battles is lethal at all, not
//     just how the defender's Counter/Blocker choices play out (see
//     baseLethalOutcome() and buildBattles()).
//
// DON!! allocation search: rather than asking the user to fix a DON amount
// per attacker and re-run one scenario at a time, they enter a total DON!!
// pool and (optionally) a per-attacker cap, and this enumerates every valid
// way to split the pool across attackers, runs the combat simulation on
// each split, and reports which splits are lethal.
//
// Attack order search: the user lists which attackers are on board, not
// what order to attack in - this searches that too, since order genuinely
// changes the outcome two different ways. First, even whether a DON!! split
// is lethal AT ALL (no Blocker/Counter assumed) depends on order: a
// multi-hit battle (Double Attack) whose excess hit would be the one taking
// Life below 0 does NOT win on its own (see the Double Attack rule above) -
// only a SEPARATE, later battle starting while Life is already 0 does - so
// putting a Double Attack last can waste its second hit for nothing.
// buildBattles() handles this cheaply without a full order search: it
// always arranges a distribution's battles with the FEWEST-hit one last,
// which is provably the best order for this specific question (an exchange
// argument - swapping any other battle into last place can only reduce the
// hits already dealt before it), so the DON!! search's "lethal at all"
// filter stays correct and cheap for every distribution. Second, once a
// split IS lethal, order affects the LETHAL PERCENTAGE too - a battle
// allowed to connect EARLY can fund Countering a more expensive one LATER,
// via the mid-turn hand-growth mechanic below (a constructed example with
// the same two battles proves both orders aren't equivalent) - and THIS is
// what the order-search pass below is actually for: for the best few DON!!
// splits already found, try reordering (bounded by a factorial cutoff -
// exhaustive up to 8 simultaneous attackers, skipped above that), using one
// quick DP call per candidate order against the average-resource estimate
// to find a promising reordering cheaply, then confirming it actually
// scores higher with the real Monte Carlo check before ever adopting it -
// so this can only improve a line's percentage, never regress it below
// buildBattles()'s own default order. See findBetterOrder() for the exact
// budget.
//
// Blocking: every attacker is simply configured as attacking the Leader -
// there's no per-attacker "which Blocker intercepts this" assignment,
// because that's not the attacker's decision to make in the first place.
// Declaring a Blocker is the DEFENDER's choice, made in response to each
// attack, using whichever active Blocker they still have - so instead the
// user enters how many active Blockers the opponent has (a count, not
// named Characters, since neither a Blocker's name nor its power affects
// whether the turn is lethal in this tool: blocking fully prevents Life
// loss from an attack regardless of the power comparison). The search
// below works out, together with Counter, the best way for the defender to
// spend that fixed number of Blockers to survive.
//
// Assumed Counter budget: the opponent's hand size and deck composition
// (how many 1000/2000-value cards, Counter Events, and - for Yellow -
// heal-Trigger cards it runs) describe their deck, same as every other
// deck-composition input in this tool. defenderCanSurvive() takes that
// budget as a single number either way it's asked to check, and it isn't
// static through a sequence: a Life card dealt as damage is added to the
// defender's hand unless it's Banished (official Q&A + printed [Banish]
// card text confirm this is unconditional otherwise - see the commit
// message for sources), and Counter has no "must have been in hand since
// the start of the turn" restriction, so a card gained from an EARLIER
// battle's damage this turn is immediately available to Counter a LATER
// battle in the same sequence - each non-Banished hit that's allowed to
// connect grows the budget (using the deck's average Counter value per
// card - see "Lethal percentage" below for why this one part stays an
// average) before the next battle is evaluated.
//
// Lethal percentage: rather than one average-based point estimate of the
// opponent's Counter/heal resources (which is still computed, as a quick
// live preview while typing - see updateCounterBudgetPreview()), each
// line shown in the results is scored by actually sampling the hidden
// information - thousands of random hands and Life piles drawn from the
// deck composition the user entered (buildDeckComposition() /
// sampleDefenderResources()), each checked for survival with the exact
// same defenderCanSurvive() used everywhere else, just fed that sample's
// REAL resources instead of the average. The percentage is the share of
// those simulated hands where the defender couldn't survive - a genuine
// Monte Carlo estimate, not a guess, though still built on the same
// simplifying assumptions documented throughout this file (discard-cost
// cards preferring non-Counter cards, the mid-sequence growth amount
// staying an average, generic Trigger effects beyond Yellow's heal not
// being modeled, DON!!/Blocker counts being known board state rather than
// resampled since they aren't hidden information). See the caveat text in
// index.html for the full list of what's still approximated.
//
// Color-specific Counter Events: a Counter Event is a card played from
// hand for an effect, instead of (or alongside) a printed Counter value -
// each one below is a SEPARATE resource from the generic 1000/2000-value
// cards, with its own hand-card (and sometimes DON!!) cost:
//   - Universal (every color): 1 hand card + 1 DON!! for +4000 power.
//     Bounded by however many such cards are assumed in the deck AND by
//     DON!! actually available AND by having a hand card to spare.
//   - Red only: 2 hand cards (the event, plus discarding another card) for
//     +3000 power, no DON!! needed.
//   - Yellow only: NOT a Counter Event - a specific Trigger variant. When
//     one of these Life cards is dealt as damage, it's played instead of
//     added to hand (so it doesn't feed the hand-growth mechanic above),
//     and the defender may discard 1 hand card to add 1 card from the top
//     of their deck to their Life area - i.e. heal 1 Life.
// Hand cards are spent on these Events first (universal, then Red), with
// "other" (non-Counter-value, non-Event) cards preferred as the discard
// cost for Red's Event and Yellow's heal - see sampleDefenderResources()
// for exactly how, and why that's a safe (defense-overestimating, not
// underestimating) simplification rather than an exact joint optimization.
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
// boards and heavier Blocker count are already captured by the Active
// Blockers count, not something this calculator needs to assume on its
// own. Green is the same for now - a Leader
// releasing in about a month is expected to let certain cards count as
// 3000 Counter, but it isn't in the game yet, so there's nothing to add
// until it releases.

(function () {
  // With the DON!! pool capped at 10 (see donPoolInput below), the number
  // of ways to split it across n attackers is C(10+n, n) - about 185,000 at
  // 10 simultaneously-attacking characters and still under 1.2M at 13, both
  // already extreme boards. This cap exists only to bound truly pathological
  // attacker counts; at any realistic size the search is exhaustive, not an
  // approximation. (Measured: ~150ms at 10 attackers, ~1s at 13-14, in
  // Node - see fuzz/bench scripts from the session that raised this.)
  const MAX_DISTRIBUTIONS = 1_000_000;
  const MAX_LINES_SHOWN = 10; // compact rows now, so more fit comfortably
  const TRIAL_COUNT = 2000; // Monte Carlo samples per line scored
  const CANDIDATE_CAP = 60; // lines eligible for scoring when more than this are base-lethal
  // Total defenderCanSurvive() calls the order-search pass (see
  // findBetterOrder()) may spend across ALL scored candidates combined, so
  // the per-candidate share shrinks automatically as a candidate's own
  // battle count (and so its n! cost) grows - see calculate() for how this
  // is actually spent. 200,000 calls measured at ~20us each in Node, so
  // ~4s worst case; always tries at least the top ORDER_SEARCH_MIN_CANDIDATES
  // regardless, as long as each is individually under ORDER_SEARCH_MAX_FACTORIAL.
  const ORDER_SEARCH_CALL_BUDGET = 200_000;
  const ORDER_SEARCH_MIN_CANDIDATES = 3;

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
  const defBlockerCountInput = document.getElementById('def-blocker-count');

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

  // Wraps an existing number <input> with −/+ buttons that bump its value
  // and dispatch 'input', same as typing would. Purely a DOM/visual change:
  // the input keeps its id/class and stays the single source of truth, so
  // every existing selector-based read (readAttackerRow, readDefenderContext,
  // etc.) keeps working completely unchanged.
  function enhanceStepper(input, { step = 1, min = 0, max = Infinity } = {}) {
    if (!input || input.dataset.stepperReady) return;
    input.dataset.stepperReady = '1';
    const wrap = document.createElement('div');
    wrap.className = 'lethal-stepper';
    input.parentNode.insertBefore(wrap, input);
    const dec = document.createElement('button');
    dec.type = 'button';
    dec.className = 'lethal-stepper-btn';
    dec.textContent = '−';
    dec.setAttribute('aria-label', 'Decrease');
    const inc = document.createElement('button');
    inc.type = 'button';
    inc.className = 'lethal-stepper-btn';
    inc.textContent = '+';
    inc.setAttribute('aria-label', 'Increase');
    wrap.append(dec, input, inc);
    input.classList.add('lethal-stepper-input');
    const bump = (delta) => {
      const current = Number(input.value) || 0;
      input.value = Math.min(max, Math.max(min, current + delta));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    dec.addEventListener('click', () => bump(-step));
    inc.addEventListener('click', () => bump(step));
    // Also clamp a directly-typed value (not just the +/- buttons) - e.g.
    // the DON!! pool can never exceed 10, the number of cards in the DON!!
    // deck.
    if (Number.isFinite(max)) {
      input.addEventListener('input', () => {
        if (Number(input.value) > max) input.value = max;
      });
    }
  }

  // Replaces a number <input> with a row of tap-to-set chips (0..max) - the
  // input itself is hidden but still the real value holder. Chips 0..value
  // highlight together, reading like a Life/filled bar rather than just a
  // single selected tick.
  function enhanceChipPicker(input, max) {
    if (!input || input.dataset.chipReady) return;
    input.dataset.chipReady = '1';
    input.classList.add('lethal-hidden-input');
    const wrap = document.createElement('div');
    wrap.className = 'lethal-chip-row';
    input.insertAdjacentElement('afterend', wrap);
    const chips = [];
    for (let i = 0; i <= max; i += 1) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'lethal-chip';
      chip.textContent = String(i);
      chip.addEventListener('click', () => {
        input.value = i;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      wrap.appendChild(chip);
      chips.push(chip);
    }
    const refresh = () => {
      const val = Number(input.value) || 0;
      chips.forEach((chip, i) => chip.classList.toggle('active', i <= val));
    };
    input.addEventListener('input', refresh);
    refresh();
  }

  // A small, purely decorative row of filled/unfilled token squares next to
  // a stepper, so a DON!! pool or Blocker count reads as a visual stack
  // instead of just a number - capped at `max` tokens shown, with the exact
  // count always still visible in the stepper's own number field.
  function enhanceTokenRow(input, max, variant) {
    if (!input || input.dataset.tokenReady) return;
    input.dataset.tokenReady = '1';
    const wrap = document.createElement('div');
    wrap.className = variant ? `lethal-token-row lethal-token-row--${variant}` : 'lethal-token-row';
    input.insertAdjacentElement('afterend', wrap);
    const tokens = [];
    for (let i = 0; i < max; i += 1) {
      const token = document.createElement('span');
      token.className = 'lethal-token';
      wrap.appendChild(token);
      tokens.push(token);
    }
    const overflow = document.createElement('span');
    overflow.className = 'lethal-token-overflow';
    wrap.appendChild(overflow);
    const refresh = () => {
      const val = Number(input.value) || 0;
      tokens.forEach((token, i) => token.classList.toggle('filled', i < val));
      overflow.textContent = val > max ? `+${val - max}` : '';
    };
    input.addEventListener('input', refresh);
    refresh();
  }

  // Restyles a checkbox + its label text into a compact toggle-chip button
  // (Double Attack / Banish) - the checkbox itself is untouched, just
  // visually hidden, so `.checked` reads exactly as before.
  function enhanceToggleChip(label) {
    if (!label || label.dataset.toggleReady) return;
    label.dataset.toggleReady = '1';
    label.classList.add('lethal-chip-toggle');
  }

  function enhanceAttackerRow(row) {
    enhanceStepper(row.querySelector('.lethal-atk-power'), { step: 1000 });
    enhanceStepper(row.querySelector('.lethal-atk-don'), { step: 1 });
    row.querySelectorAll('.lethal-checkbox').forEach(enhanceToggleChip);
  }

  // Colors each "Your Board" row with the exact same accent attackerAccent()
  // gives its sequence tile in the results, by this attacker's STABLE
  // roster index (its position in the attacksThisTurn-filtered list
  // calculate() builds) - a color identifies WHICH attacker this is, not
  // where they land in a line's (now search-chosen, not user-set) attack
  // order, so row and tile always match by identity even when a result's
  // sequence reorders them. Only the Leader can opt out (its own checkbox);
  // every Character row always attacks, so only the Leader shifts indices
  // when toggled.
  function refreshAttackerAccents() {
    const leaderRow = leaderRowContainer.querySelector('.lethal-attacker-row');
    const leaderAttacks = leaderRow.querySelector('.lethal-atk-attacks').checked;
    const charRows = [...attackersList.querySelectorAll('.lethal-attacker-row')];
    let index = 0;
    if (leaderAttacks) {
      leaderRow.style.setProperty('--seq-accent', attackerAccent(index));
      index += 1;
    } else {
      leaderRow.style.removeProperty('--seq-accent');
    }
    charRows.forEach((row) => {
      row.style.setProperty('--seq-accent', attackerAccent(index));
      index += 1;
    });
  }

  // The Character Area has exactly 5 slots, so a legal board can never have
  // more than 5 Characters attacking alongside the Leader - 6 attackers
  // total. Enforced here (not just documented) so the board this tool can
  // describe always matches a real one; it also means the order-search
  // pass below (bounded up to 8! = 40,320 orders) can never actually hit
  // its own cutoff - 6! = 720 is comfortably inside it.
  const MAX_CHARACTERS = 5;

  function updateAddCharacterAvailability() {
    const atLimit = attackersList.querySelectorAll('.lethal-attacker-row').length >= MAX_CHARACTERS;
    addAttackerBtn.disabled = atLimit;
    addAttackerBtn.title = atLimit ? 'The Character Area only has 5 slots - this is the legal maximum.' : '';
  }

  function addAttackerRow() {
    if (attackersList.querySelectorAll('.lethal-attacker-row').length >= MAX_CHARACTERS) return;
    const node = attackerTemplate.content.cloneNode(true);
    const row = node.querySelector('.lethal-attacker-row');
    row.querySelector('.lethal-remove-btn').addEventListener('click', () => {
      row.remove();
      refreshAttackerAccents();
      updateAddCharacterAvailability();
    });
    attackersList.appendChild(row);
    enhanceAttackerRow(row);
    refreshAttackerAccents();
    updateAddCharacterAvailability();
  }

  function initLeaderRow() {
    const node = leaderTemplate.content.cloneNode(true);
    leaderRowContainer.appendChild(node);
    const row = leaderRowContainer.querySelector('.lethal-attacker-row');
    enhanceAttackerRow(row);
    row.querySelector('.lethal-atk-attacks').addEventListener('change', refreshAttackerAccents);
    refreshAttackerAccents();
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
    };
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Averages the opponent's generic deck composition into an assumed
  // Counter value per card. This average still feeds the mid-sequence
  // hand-growth estimate in defenderCanSurvive() (see the header comment
  // for why that part stays an average rather than a full sample), but the
  // STARTING budget now comes from actual sampled hands - see
  // buildDeckComposition() below. Also returns the raw n2000/n1000 counts
  // (not just their average) since the sampler needs real card counts.
  function computeCounterBudget() {
    const handSize = Math.max(0, Math.floor(Number(handSizeInput.value)) || 0);
    const n2000 = Math.max(0, Number(counter2000Input.value)) || 0;
    const n1000 = Math.max(0, Number(counter1000Input.value)) || 0;
    const deckSize = Math.max(1, Number(deckSizeInput.value) || 1);
    const avgPerCard = (2000 * n2000 + 1000 * n1000) / deckSize;
    return { handSize, avgPerCard, deckSize, n2000, n1000 };
  }

  // A cheap, instant, average-based estimate shown while typing - the
  // actual lethal percentage shown after clicking "Find Lethal Lines" is
  // more rigorous (Monte Carlo over real sampled hands, not this average),
  // so this is a rough preview, not the final answer.
  function updateCounterBudgetPreview() {
    const defender = readDefenderContext();
    counterBudgetPreview.textContent =
      `Quick estimate: ~${Math.round(defender.counterBudget).toLocaleString()} Counter and ` +
      `${defender.blockerCount} Blocker${defender.blockerCount === 1 ? '' : 's'} available this turn` +
      `${defender.healUses ? `, plus healing to ${defender.effectiveStartingLife} effective Life` : ''}. ` +
      `Click "Find Lethal Lines" for an exact percentage.`;
  }

  // Bundles every "what do we know/assume about the opponent" into one
  // object, so buildBattles()/baseLethalOutcome() and defenderCanSurvive()
  // have a single, stable place to read from - including the color-specific
  // Counter Events (see the header comment for the exact mechanics and the
  // simplifications involved). Hand cards are spent on Events first (universal, then Red),
  // and whatever's left funds the generic average-value Counter budget;
  // Yellow's heal is capped by hand size but tracked independently of that
  // spend - a documented, deliberately conservative simplification.
  function readDefenderContext() {
    const { avgPerCard, handSize, deckSize, n2000, n1000 } = computeCounterBudget();
    const startingLife = Math.max(0, Number(defLifeInput.value) || 0);
    const color = defLeaderColorInput.value;
    const secondaryColor = defLeaderColor2Input.value || null;
    const donAvailable = Math.max(0, Math.floor(Number(defDonAvailableInput.value)) || 0);
    // The Character Area only has 5 slots, so the defender can never have
    // more than 5 active Blockers - clamped here too, not just in the
    // stepper's own input handling (same reasoning as the DON!! pool's
    // clamp to 10 in calculate()).
    const blockerCount = Math.min(5, Math.max(0, Math.floor(Number(defBlockerCountInput.value)) || 0));
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
      blockerCount,
      counterBudget,
      counterBudgetUnits,
      avgPerCard,
      handSize,
      deckSize,
      n2000,
      n1000,
      universalEventCount,
      redEventCount,
      yellowHealCount,
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

  // Builds the per-attacker battle stats (hits, Counter cost to negate,
  // Banish) for one specific DON!! split - each one is intrinsic to that
  // attacker and its assigned DON!!, so unlike the old resolveLine(), this
  // needs no attack order at all. Only attackers that actually connect
  // (effective power >= Leader power) get a battle entry; each one carries
  // its `rosterIndex` (position in the attacksThisTurn-filtered attackers
  // list - the same stable identity used for accent colors) so a later
  // reordering (see findBetterOrder() below) can still be traced back to
  // who's attacking and rendered/logged correctly.
  //
  // Sorted with the FEWEST-hit battle last as the default order - see the
  // header comment on Double Attack for why that specific arrangement
  // maximizes whether a split is lethal at all, before any order search
  // (findBetterOrder()) even runs: putting a Double Attack LAST risks
  // wasting its second hit against a defender who's already at 0 Life,
  // since (per the official ruling) that doesn't win the game - only a
  // SEPARATE, later attack starting while Life is already 0 does.
  function buildBattles(attackers, donAssignment, defender) {
    const battles = [];
    const defPower = defender.leaderPower;
    for (let i = 0; i < attackers.length; i += 1) {
      const attacker = attackers[i];
      const effectivePower = attacker.power + donAssignment[i] * 1000;
      // Color-specific Counter Events (universal/Red) add power here too,
      // but as part of the shared Counter budget evaluated per-battle in
      // defenderCanSurvive() rather than a static boost to defPower itself
      // - see the header comment.
      if (effectivePower < defPower) continue;
      const hits = attacker.double ? 2 : 1;
      const costPower = (Math.floor((effectivePower - defPower) / 1000) + 1) * 1000;
      battles.push({ rosterIndex: i, hits, costPower, banish: attacker.banish });
    }
    battles.sort((a, b) => b.hits - a.hits);
    return battles;
  }

  // Whether a given, ORDERED set of battles is lethal at all, and the Life
  // total it leaves behind, assuming NO Blocker/Counter - i.e. every
  // connecting battle takes as many Life cards as are left, up to its own
  // hit count. Order matters here, unlike a flat hit-count sum would
  // suggest: a Double Attack (or any multi-hit battle) that would be the
  // one bringing Life below 0 does NOT win the game on its own - per the
  // official ruling (One Piece Card Game Comprehensive Rules FAQ, Double
  // Attack 4-10/4-11: a Double Attack cannot defeat a 1-Life opponent) a
  // player loses only when THEY'RE ATTACKED WHILE ALREADY AT 0 LIFE - not
  // merely when more damage is nominally dealt than Life remaining. So a
  // battle whose hits exceed the Life actually left just takes however many
  // cards ARE left (capped) and stops there, with no loss triggered by that
  // excess - only a battle that STARTS with Life already at 0 (from an
  // earlier battle having already exhausted it) triggers the loss. Passing
  // battles in the order buildBattles() sorts them in (fewest hits last)
  // gives this function's BEST possible answer for a given set of battles;
  // the DON!! search relies on exactly that to filter "lethal at all"
  // without needing a full order search for every distribution - see the
  // header comment and findBetterOrder() for where order is searched
  // further, for the Counter/Blocker interaction specifically.
  function baseLethalOutcome(battles, startingLife) {
    let lifeTaken = 0;
    let lethal = false;
    for (const battle of battles) {
      if (lifeTaken >= startingLife) {
        lethal = true;
        break;
      }
      lifeTaken = Math.min(startingLife, lifeTaken + battle.hits);
    }
    return { lethal, finalLife: startingLife - lifeTaken };
  }

  // The human-readable play-by-play for one specific line, in a specific
  // `displayOrder` (an array of roster indices - the attack order to narrate
  // in, whether that's the search-chosen order for a scored line or just
  // roster order for the no-attacks-landed/no-attackers fallbacks). Same
  // no-Blocker/no-Counter assumption and the same capped-per-battle Life
  // model as baseLethalOutcome() (see its comment for the Double Attack
  // ruling this encodes) - built only for lines that end up displayed, not
  // for every distribution the search explores.
  function buildLineLog(attackers, donAssignment, displayOrder, defender) {
    const log = [];
    let life = defender.startingLife;
    let lethal = false;

    for (const i of displayOrder) {
      const attacker = attackers[i];
      const donAssigned = donAssignment[i];
      const effectivePower = attacker.power + donAssigned * 1000;
      const donNote = donAssigned ? ` (+${donAssigned} DON)` : '';
      const defPower = defender.leaderPower;

      if (effectivePower < defPower) {
        log.push({
          type: 'fail',
          text: `${attacker.name}${donNote} (${effectivePower.toLocaleString()}) doesn't get through the Leader (${defPower.toLocaleString()}). No Life lost.`,
        });
        continue;
      }

      if (lethal) {
        log.push({ type: 'note', text: `${attacker.name} also connects, but the game is already over by this point.` });
        continue;
      }

      if (life <= 0) {
        lethal = true;
        log.push({ type: 'lethal', text: `${attacker.name} hits the Leader while Life is already 0 - LETHAL.` });
        continue;
      }

      const hits = attacker.double ? 2 : 1;
      const cardsTaken = Math.min(hits, life);
      life -= cardsTaken;
      const banishNote = attacker.banish ? 'Banished - no Trigger' : 'revealed - Trigger may activate';
      const cardWord = cardsTaken === 1 ? 'card' : 'cards';
      const doubleNote =
        hits === 2 && cardsTaken === 1
          ? ` (Double Attack, but only 1 Life card was left to take - the second hit has nothing to take and does nothing)`
          : '';
      log.push({
        type: 'hit',
        text: `${attacker.name}${donNote} hits the Leader (${effectivePower.toLocaleString()} vs ${defPower.toLocaleString()}). ${cardsTaken} Life ${cardWord} removed (${banishNote})${doubleNote}. Life now ${life}.`,
      });
    }

    return log;
  }

  // Determines whether the defender can survive this line's battles using
  // their assumed Counter budget AND their fixed Blocker count together,
  // accounting for the budget growing mid-turn from non-Banished Life cards
  // reaching hand (see the header comment for why that's rules-accurate).
  // Each battle has three possible outcomes: Blocked (free, costs 1 of the
  // fixed Blocker count, no hits, no hand gain - since the attack never
  // reaches the Leader at all), Countered (spend its cost now, no hits, no
  // hand gain), or allowed to connect. Connecting only loses the game if the
  // defender was ALREADY at 0 Life when this battle started - a battle
  // itself never loses the game by nominally dealing more hits than Life
  // remains; it just takes however many Life cards are actually left
  // (capped) and stops there (see baseLethalOutcome()'s comment for the
  // official Double Attack ruling this encodes, and for why battle order
  // matters to this at all). A connecting battle's hand-growth gain is
  // based on the Life cards it ACTUALLY took, not its nominal hit count -
  // the official ruling is explicit that a hit with nothing left to take
  // just does nothing, Trigger included.
  //
  // Blocking is never worse than Countering the same battle (same result,
  // but free instead of costing budget) - EXCEPT that Blockers are a
  // separate, limited resource from Counter, so which battles get the free
  // block and which get Countered (or connect) genuinely matters: blocking
  // the battle that's cheapest to Counter can strand an expensive one that
  // the budget can't cover, when blocking the EXPENSIVE one and Countering
  // the cheap one would have survived. That's a real joint optimization,
  // not something a simple "block the biggest hits first" rule gets right
  // in every case - so this solves it exactly.
  //
  // Solved with a DP over (battle index, Life cards taken so far - capped at
  // effectiveStartingLife, Blockers used so far) -> the MAXIMUM achievable
  // running Counter budget for that state. A higher budget can only ever
  // help later decisions, so only the max per state needs to be kept - this
  // keeps the search polynomial (battles × Life × Blocker count) instead of
  // exponential, even though the decisions are sequential (budget earned
  // from one battle can't be spent on an earlier one, and a used Blocker
  // can't be reused). A state with lifeTaken already at the cap simply has
  // no "connect" transition out of it in the code below - that's exactly
  // "attacked again while already at 0 Life," the actual loss condition -
  // so it's not a state defenderCanSurvive() needs to represent at all; any
  // state that DOES survive to the end of the loop is, by construction, one
  // that never hit that condition.
  //
  // defender.counterBudget already includes color-specific Counter Event
  // power (universal + Red) via readDefenderContext(), and
  // defender.effectiveStartingLife already includes Yellow's assumed heal
  // uses - this function doesn't need to know about color/DON!! directly,
  // just these two pre-computed numbers plus the Blocker count.
  function defenderCanSurvive(battles, defender) {
    const { effectiveStartingLife, counterBudget, avgPerCard, blockerCount } = defender;
    const maxBlocks = Math.min(blockerCount, battles.length); // blocking more battles than exist is pointless

    let dp = Array.from({ length: effectiveStartingLife + 1 }, () => new Array(maxBlocks + 1).fill(-Infinity));
    dp[0][0] = counterBudget;

    for (const battle of battles) {
      const next = Array.from({ length: effectiveStartingLife + 1 }, () => new Array(maxBlocks + 1).fill(-Infinity));
      for (let lifeTaken = 0; lifeTaken <= effectiveStartingLife; lifeTaken += 1) {
        for (let b = 0; b <= maxBlocks; b += 1) {
          const budget = dp[lifeTaken][b];
          if (budget === -Infinity) continue;

          // Block: free, but uses up 1 of the fixed Blocker count.
          if (b < maxBlocks && budget > next[lifeTaken][b + 1]) {
            next[lifeTaken][b + 1] = budget;
          }

          // Counter: spend its cost now, no hits, no hand gain.
          if (budget >= battle.costPower && budget - battle.costPower > next[lifeTaken][b]) {
            next[lifeTaken][b] = budget - battle.costPower;
          }

          // Let it connect - only possible (i.e. survivable) if NOT already
          // at the cap; takes up to battle.hits Life cards, however many
          // are actually left, and grows the budget by that ACTUAL count
          // (unless Banished), not the nominal hit count.
          if (lifeTaken < effectiveStartingLife) {
            const newLifeTaken = Math.min(effectiveStartingLife, lifeTaken + battle.hits);
            const cardsTaken = newLifeTaken - lifeTaken;
            const gained = budget + (battle.banish ? 0 : cardsTaken * avgPerCard);
            if (gained > next[newLifeTaken][b]) next[newLifeTaken][b] = gained;
          }
        }
      }
      dp = next;
    }

    for (let lifeTaken = 0; lifeTaken <= effectiveStartingLife; lifeTaken += 1) {
      for (let b = 0; b <= maxBlocks; b += 1) {
        if (dp[lifeTaken][b] !== -Infinity) return true;
      }
    }
    return false;
  }

  function factorial(n) {
    let f = 1;
    for (let i = 2; i <= n; i += 1) f *= i;
    return f;
  }

  // Calls `onPermutation(orderArray)` for every permutation of [0..n-1] (via
  // Heap's algorithm, so each step is a single swap - no array-building
  // overhead beyond the one slice() needed to hand the caller a stable
  // copy), stopping as soon as it returns true. The identity order
  // ([0,1,...,n-1], i.e. "don't reorder") is always visited first.
  function forEachPermutation(n, onPermutation) {
    const indices = Array.from({ length: n }, (_, i) => i);
    if (onPermutation(indices.slice())) return;
    const c = new Array(n).fill(0);
    let i = 0;
    while (i < n) {
      if (c[i] < i) {
        if (i % 2 === 0) [indices[0], indices[i]] = [indices[i], indices[0]];
        else [indices[c[i]], indices[i]] = [indices[i], indices[c[i]]];
        if (onPermutation(indices.slice())) return;
        c[i] += 1;
        i = 0;
      } else {
        c[i] = 0;
        i += 1;
      }
    }
  }

  // Order genuinely changes a line's survivability: a battle allowed to
  // connect EARLY can fund Countering a pricier one LATER (the mid-turn
  // hand-growth mechanic), so a defender facing battles in one order can
  // survive when the same battles in another order would be lethal. Trying
  // every order against the real Monte Carlo check (TRIAL_COUNT samples
  // each) is what we actually want, but is far too expensive to run for
  // every candidate line and every one of its n! orders - so this instead
  // runs ONE cheap defenderCanSurvive() call per order, against the
  // defender's single average-resource estimate (the same numbers behind
  // the live "Quick estimate" preview - see readDefenderContext()), and
  // returns the first order (other than the given one) where even that
  // average-resource defender can't survive. That's a proxy, not a proof -
  // the caller (calculate()) only ever ADOPTS the returned order after
  // confirming it scores higher under the real Monte Carlo check too, so a
  // bad proxy pick just gets discarded rather than ever making a line worse
  // than leaving its battles in roster order.
  //
  // Bounded by ORDER_SEARCH_MAX_FACTORIAL so this never attempts something
  // like 10! (3.6M) orders - beyond that, this returns null immediately
  // (no reorder attempted) rather than hanging the search for an extreme
  // board size; see calculate() for how many of a result set's candidates
  // actually get a budget to call this at all.
  const ORDER_SEARCH_MAX_FACTORIAL = 100_000; // n <= 8 (8! = 40,320); n = 9 (362,880) is already over this

  function findBetterOrder(battles, defender) {
    const n = battles.length;
    if (n <= 1 || factorial(n) > ORDER_SEARCH_MAX_FACTORIAL) return null;
    let found = null;
    forEachPermutation(n, (order) => {
      if (order.every((v, i) => v === i)) return false; // the given order itself - nothing to adopt
      const ordered = order.map((idx) => battles[idx]);
      if (!defenderCanSurvive(ordered, defender)) {
        found = ordered;
        return true;
      }
      return false;
    });
    return found;
  }

  // Builds one flat array of card-category labels representing the
  // opponent's full deck, for Monte Carlo sampling of their actual hand
  // and Life-pile composition (see "Lethal percentage" in the header
  // comment). Only the categories that matter to this calculator are
  // tracked individually - 2000/1000-value Counter cards, universal/Red
  // Counter Events, and Yellow's heal-Trigger cards - everything else is
  // lumped into "other". If the specific counts (or the hand+Life draw
  // size) exceed the entered deck size, the deck is treated as exactly
  // that large instead of erroring - a deck can't deal more cards than it
  // has.
  function buildDeckComposition(defender) {
    const hasColor = (c) => defender.color === c || defender.secondaryColor === c;
    const counts = {
      c2000: defender.n2000,
      c1000: defender.n1000,
      universal: defender.universalEventCount,
      red: hasColor('red') ? defender.redEventCount : 0,
      yellowHeal: hasColor('yellow') ? defender.yellowHealCount : 0,
    };
    const specificTotal = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const drawNeeded = defender.handSize + defender.startingLife;
    const effectiveDeckSize = Math.max(defender.deckSize, specificTotal, drawNeeded);

    const composition = [];
    for (const [category, count] of Object.entries(counts)) {
      for (let i = 0; i < count; i += 1) composition.push(category);
    }
    while (composition.length < effectiveDeckSize) composition.push('other');
    return composition;
  }

  function shuffleInPlace(array) {
    for (let i = array.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }

  // One random draw of the opponent's hand and Life pile from
  // `composition`, converted into the same { counterBudget,
  // effectiveStartingLife } shape defenderCanSurvive() already expects -
  // so a sample can be checked with the exact same DP used everywhere
  // else, just fed real sampled resources instead of the single average.
  //
  // Hand cards are spent on Events first (universal, then Red), preferring
  // "other" cards as the discard cost for Red's Event and Yellow's heal -
  // keeping Counter-value cards for their printed value whenever possible,
  // matching how the user described these being played ("discard another
  // card that does not have a counter"). If there aren't enough "other"
  // cards to cover a discard, that Event/heal simply isn't used in this
  // sample rather than sacrificing a Counter-value card - a conservative
  // simplification that very rarely binds in practice, since most of a
  // real deck isn't Counter cards or Events.
  function sampleDefenderResources(composition, defender) {
    const draw = composition.slice();
    shuffleInPlace(draw);
    const hand = draw.slice(0, defender.handSize);
    const life = draw.slice(defender.handSize, defender.handSize + defender.startingLife);
    const count = (arr, category) => arr.reduce((n, c) => n + (c === category ? 1 : 0), 0);

    const handC2000 = count(hand, 'c2000');
    const handC1000 = count(hand, 'c1000');
    const handUniversal = count(hand, 'universal');
    const handRed = count(hand, 'red');
    const handOther = count(hand, 'other');
    const lifeHeal = count(life, 'yellowHeal');

    const universalUses = Math.min(handUniversal, defender.donAvailable);
    const redUses = Math.min(handRed, handOther);
    const healUses = Math.min(lifeHeal, handOther - redUses);

    const counterBudget = handC2000 * 2000 + handC1000 * 1000 + universalUses * 4000 + redUses * 3000;
    const effectiveStartingLife = defender.startingLife + healUses;

    return { counterBudget, effectiveStartingLife };
  }

  // Pre-draws `trialCount` random hand/Life samples ONCE per calculate()
  // call, shared across every DON!! line being scored - the opponent's
  // deck composition doesn't depend on the attacker's DON!! split, so
  // there's no reason to re-sample per line.
  function buildResourceSamples(defender, trialCount) {
    const composition = buildDeckComposition(defender);
    const samples = [];
    for (let i = 0; i < trialCount; i += 1) {
      samples.push(sampleDefenderResources(composition, defender));
    }
    return samples;
  }

  // Estimates P(this line is lethal) as the share of sampled hands where
  // the defender's ACTUAL drawn resources - not the single average
  // estimate - can't save them. Reuses defenderCanSurvive() unchanged for
  // each sample: only counterBudget/effectiveStartingLife vary per draw,
  // while avgPerCard (for mid-sequence hand growth - see the header
  // comment for why that part stays an average) and blockerCount/
  // donAvailable (known board state, not hidden information) stay fixed.
  function estimateLethalPercent(battles, resourceSamples, defender) {
    let survives = 0;
    for (const sample of resourceSamples) {
      const trialDefender = {
        ...defender,
        counterBudget: sample.counterBudget,
        effectiveStartingLife: sample.effectiveStartingLife,
      };
      if (defenderCanSurvive(battles, trialDefender)) survives += 1;
    }
    return Math.round((100 * (resourceSamples.length - survives)) / resourceSamples.length);
  }

  function calculate() {
    const defender = readDefenderContext();
    // A player's total DON!! this turn can never exceed 10 (the whole
    // DON!! deck) - clamped here too, not just in the stepper's own input
    // handling, since this is a hard game rule the search's correctness
    // depends on (see the MAX_DISTRIBUTIONS comment above).
    const totalDon = Math.min(10, Math.max(0, Math.floor(Number(donPoolInput.value)) || 0));

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

    // buildBattles() already arranges each distribution's battles in its
    // best order for the base lethal check (fewest hits last - see its
    // comment and the Double Attack rule in the header comment), so
    // baseLethalOutcome() here gives the correct "lethal at all" answer
    // without needing a per-distribution order search. That same order is
    // also just the starting point findBetterOrder() may improve on below,
    // for the Counter/Blocker interaction, on whichever lines end up
    // actually being scored.
    const results = distributions.map((donAssignment) => {
      const battles = buildBattles(attackers, donAssignment, defender);
      const { lethal, finalLife } = baseLethalOutcome(battles, defender.startingLife);
      const donUsed = donAssignment.reduce((sum, x) => sum + x, 0);
      return { donAssignment, donUsed, lethal, finalLife, battles };
    });

    // Score every base-lethal line's actual chance of staying lethal, via
    // Monte Carlo over real sampled hands (see estimateLethalPercent()).
    // Cheap to do for however many lines actually come up in normal use;
    // CANDIDATE_CAP only kicks in for pathologically large DON!! searches,
    // favoring the most-DON!!-used lines so the cap doesn't drop the
    // eventual winner (see the tie-break note below) for the common case.
    const lethalResults = results.filter((r) => r.lethal);
    let scored = [];
    if (lethalResults.length) {
      const shortlist =
        lethalResults.length <= CANDIDATE_CAP
          ? lethalResults
          : lethalResults
              .slice()
              .sort((a, b) => b.donUsed - a.donUsed)
              .slice(0, CANDIDATE_CAP);
      const resourceSamples = buildResourceSamples(defender, TRIAL_COUNT);
      // Tie-break toward using MORE of the pool, not less: giving an
      // attacker extra DON!! can only raise (never lower) a line's percent
      // - it strictly raises the Counter cost to negate that battle - so
      // whenever two distributions tie on percent, the one spending more
      // DON!! is at worst just as good and never a real downgrade. This is
      // what actually finds "the distribution that uses all available
      // DON!! and is best" - every full-pool split is already enumerated
      // above and scored here, so the sort just needs to prefer it.
      scored = shortlist
        .map((r) => ({ ...r, percent: estimateLethalPercent(r.battles, resourceSamples, defender) }))
        .sort((a, b) => b.percent - a.percent || b.donUsed - a.donUsed);

      // Order search, second pass: try reordering the best few candidates'
      // battles (see findBetterOrder() for exactly how and why this can
      // only ever help, never regress a line below its roster-order score)
      // and re-rank once any improvements are in. Budgeted in total DP-call
      // count rather than a fixed candidate count, since candidates can
      // have very different battle counts (and therefore wildly different
      // per-candidate search costs) within the same result set; always
      // tries at least the top few regardless of cost, as long as a single
      // one of their orders is individually affordable.
      let orderSearchBudget = ORDER_SEARCH_CALL_BUDGET;
      let orderSearchAttempts = 0;
      for (const candidate of scored) {
        const cost = factorial(candidate.battles.length);
        if (cost > ORDER_SEARCH_MAX_FACTORIAL) continue;
        if (orderSearchAttempts >= ORDER_SEARCH_MIN_CANDIDATES && cost > orderSearchBudget) continue;
        orderSearchBudget -= cost;
        orderSearchAttempts += 1;

        const betterOrder = findBetterOrder(candidate.battles, defender);
        if (!betterOrder) continue;
        const newPercent = estimateLethalPercent(betterOrder, resourceSamples, defender);
        if (newPercent > candidate.percent) {
          candidate.battles = betterOrder;
          candidate.percent = newPercent;
        }
      }
      scored.sort((a, b) => b.percent - a.percent || b.donUsed - a.donUsed);
    } else {
      const best = results.slice().sort((a, b) => a.finalLife - b.finalLife || b.donUsed - a.donUsed)[0];
      if (best) scored = [{ ...best, percent: 0 }];
    }

    // The display order for each scored line: its battles' rosterIndex
    // values (in whatever order findBetterOrder() above settled on, or
    // plain roster order if it wasn't attempted or found nothing better),
    // followed by any attackers that don't connect at all in this line -
    // their position can't affect the outcome, so they're just appended in
    // roster order at the end.
    for (const result of scored) {
      const connected = new Set(result.battles.map((b) => b.rosterIndex));
      result.order = [
        ...result.battles.map((b) => b.rosterIndex),
        ...attackers.map((_, i) => i).filter((i) => !connected.has(i)),
      ];
    }

    renderSearchResult({ attackers, scored, totalDon, truncated, defender });
  }

  // A consistent, per-attacker accent color (cycled by index, not by DON
  // amount) so the same attacker reads as the same color across every line
  // shown - used only for the sequence-tile visualization below, purely
  // cosmetic.
  function attackerAccent(index) {
    return `hsl(${(index * 57) % 360}deg 65% 60%)`;
  }

  // Renders one line's attack order (result.order - the search-chosen
  // sequence, see calculate()) as a compact row of small tiles - each one's
  // effective power (base + DON!! this line assigns it) and a short name
  // tag - so a line can be scanned at a glance instead of read as a
  // sentence. Each tile is colored by attackerAccent(rosterIndex) - the
  // SAME identity-based color as that attacker's "Your Board" row - so a
  // tile reads as "this specific attacker," not "whatever's in this slot
  // today," even though which slot they land in can now vary line to line.
  // The full play-by-play log is still available (see renderLine()), just
  // no longer the only way to see what a line does.
  function renderSequenceTiles(attackers, result) {
    return result.order
      .map((i) => {
        const a = attackers[i];
        const don = result.donAssignment[i];
        const effectivePower = a.power + don * 1000;
        const tag = a.isLeader ? 'Leader' : a.name;
        const donNote = don ? ` +${don} DON` : '';
        return `
          <span class="lethal-seq-tile" style="--seq-accent: ${attackerAccent(i)}" title="${escapeHtml(tag)}${escapeHtml(donNote)}">
            <span class="lethal-seq-power">${(effectivePower / 1000).toLocaleString()}K</span>
            <span class="lethal-seq-tag">${escapeHtml(tag)}</span>
          </span>
        `;
      })
      .join('<span class="lethal-seq-arrow">→</span>');
  }

  function percentTier(percent) {
    return percent >= 75 ? 'yes' : percent >= 25 ? 'caution' : 'no';
  }

  // A compact, scannable row for one line: percent + a thin bar (so
  // relative strength reads at a glance down the list), the sequence
  // tiles, and DON!! used - with the full text log tucked behind a native
  // <details> disclosure instead of always being shown. `open` keeps the
  // recommended line's log visible by default; every other line starts
  // collapsed, since the compact row already says what matters for
  // scanning the list.
  function renderLine(attackers, result, totalDon, open, defender) {
    const log = buildLineLog(attackers, result.donAssignment, result.order, defender);
    const logHtml = log.length
      ? `<ul class="lethal-log">${log.map((entry) => `<li class="lethal-log-${entry.type}">${escapeHtml(entry.text)}</li>`).join('')}</ul>`
      : '<p class="empty-state">No attacks landed.</p>';
    const tier = percentTier(result.percent);
    return `
      <details class="lethal-line-row" ${open ? 'open' : ''}>
        <summary class="lethal-line-summary">
          <span class="lethal-line-percent lethal-line-percent-${tier}">
            <span class="lethal-line-percent-value">${result.percent}%</span>
            <span class="lethal-line-percent-bar"><span style="width: ${result.percent}%"></span></span>
          </span>
          <span class="lethal-seq">${renderSequenceTiles(attackers, result)}</span>
          <span class="lethal-line-don">${result.donUsed}/${totalDon} DON!!</span>
        </summary>
        <div class="lethal-line-detail">${logHtml}</div>
      </details>
    `;
  }

  // One number per line replaces the old "robustly lethal vs. soft lethal,
  // X of Y explored" framing: that distinction is still exactly what the
  // percentage encodes (a robust line scores near 100%, a soft one lower),
  // just continuous instead of a binary bucket and without the multi-
  // paragraph explanation each bucket used to need.
  function renderSearchResult({ attackers, scored, totalDon, truncated, defender }) {
    resultEl.hidden = false;

    if (!scored.length) {
      resultEl.classList.remove('lethal-result-yes', 'lethal-result-caution');
      resultEl.classList.add('lethal-result-no');
      resultEl.innerHTML = '<h2>No attacks landed in any explored line.</h2>';
      resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    const top = scored[0];
    const others = scored.slice(1, MAX_LINES_SHOWN);
    const tier = percentTier(top.percent);

    resultEl.classList.remove('lethal-result-yes', 'lethal-result-caution', 'lethal-result-no');
    resultEl.classList.add(`lethal-result-${tier}`);

    const assumptionsNote = `<p class="lethal-hint">Based on ${defender.handSize} hand card${defender.handSize === 1 ? '' : 's'} and ${defender.startingLife} Life drawn from the deck described above, plus ${defender.blockerCount} Blocker${defender.blockerCount === 1 ? '' : 's'} and ${defender.donAvailable} DON!! (both known, not random) - percentages are a Monte Carlo estimate across ${TRIAL_COUNT.toLocaleString()} simulated hands, not a guarantee.</p>`;
    const truncNote = truncated
      ? `<p class="lethal-hint">DON!! search capped at ${MAX_DISTRIBUTIONS.toLocaleString()} allocations explored.</p>`
      : '';

    const ringColorVar = tier === 'yes' ? 'var(--up)' : tier === 'caution' ? 'var(--warn)' : 'var(--down)';
    const badge = top.percent === 0 ? 'CLOSEST LINE' : 'BEST LINE';
    const metaLine =
      top.percent === 0
        ? `Not lethal with this plan - opponent survives with ${top.finalLife} Life left.`
        : totalDon === 0
          ? 'No DON!! needed - the strongest line at this chance of lethal.'
          : top.donUsed === totalDon
            ? `Uses all ${totalDon} DON!! available - the strongest line at this chance of lethal.`
            : `${top.donUsed} of ${totalDon} DON!! used - the strongest line at this chance of lethal (the rest wouldn't improve it).`;

    const topLog = buildLineLog(attackers, top.donAssignment, top.order, defender);

    resultEl.innerHTML = `
      <div class="lethal-best-card">
        <div class="lethal-ring" style="--pct: ${top.percent}; --ring-color: ${ringColorVar}">
          <div class="lethal-ring-inner">${top.percent}%</div>
        </div>
        <div class="lethal-best-body">
          <span class="lethal-best-badge">${badge}</span>
          <div class="lethal-seq lethal-seq-best">${renderSequenceTiles(attackers, top)}</div>
          <p class="lethal-best-meta">${metaLine}</p>
        </div>
      </div>
      <details class="lethal-line-detail-standalone" open>
        <summary>Full play-by-play for this line</summary>
        <p class="lethal-hint">Shown in the attack order recommended above, assuming the opponent plays no Blocker or Counter at all - that's what sets the hit count below. The percentage above is what's actually checked against their Blockers, Counter, and DON!! (see the note below).</p>
        ${
          topLog.length
            ? `<ul class="lethal-log">${topLog.map((entry) => `<li class="lethal-log-${entry.type}">${escapeHtml(entry.text)}</li>`).join('')}</ul>`
            : '<p class="empty-state">No attacks landed.</p>'
        }
      </details>
      ${assumptionsNote}
      ${truncNote}
      ${
        others.length
          ? `<h3>All lines explored — ${(others.length + 1).toLocaleString()} shown</h3><div class="lethal-lines-list">${others
              .map((r) => renderLine(attackers, r, totalDon, false, defender))
              .join('')}</div>`
          : ''
      }
    `;
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  addAttackerBtn.addEventListener('click', addAttackerRow);
  calculateBtn.addEventListener('click', calculate);
  [
    handSizeInput,
    counter2000Input,
    counter1000Input,
    deckSizeInput,
    defLifeInput,
    defDonAvailableInput,
    defBlockerCountInput,
    universalEventCountInput,
    redEventCountInput,
    yellowHealCountInput,
  ].forEach((el) => el.addEventListener('input', updateCounterBudgetPreview));
  [defLeaderColorInput, defLeaderColor2Input].forEach((el) =>
    el.addEventListener('change', updateCounterBudgetPreview),
  );

  // Presentation-only enhancements - every field below keeps its original
  // id/class and value contract, so none of the calculation code above (or
  // the input-event listeners just wired up) needs to know these exist.
  enhanceStepper(defLeaderPowerInput, { step: 1000 });
  enhanceStepper(defDonAvailableInput, { step: 1 });
  enhanceStepper(handSizeInput, { step: 1 });
  enhanceStepper(counter2000Input, { step: 1 });
  enhanceStepper(counter1000Input, { step: 1 });
  enhanceStepper(deckSizeInput, { step: 1, min: 1 });
  enhanceStepper(universalEventCountInput, { step: 1 });
  enhanceStepper(redEventCountInput, { step: 1 });
  enhanceStepper(yellowHealCountInput, { step: 1 });
  enhanceChipPicker(defLifeInput, 10);
  // The Character Area only has 5 slots, so Active Blockers can never
  // exceed 5.
  enhanceStepper(defBlockerCountInput, { step: 1, max: 5 });
  enhanceTokenRow(defBlockerCountInput, 5, 'blocker');
  // A player's total DON!! this turn can never exceed 10 - that's the
  // entire DON!! deck.
  enhanceStepper(donPoolInput, { step: 1, max: 10 });
  enhanceTokenRow(donPoolInput, 10);

  initLeaderRow();
  addAttackerRow();
  updateCounterBudgetPreview();
})();
