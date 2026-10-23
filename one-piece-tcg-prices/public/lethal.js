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
// way to split the pool across attackers (attack order is fixed as
// configured), runs the combat simulation on each split, and reports which
// splits are lethal. Order isn't searched - only the DON!! split is - to
// keep the search space bounded and the result legible.
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
  const MAX_DISTRIBUTIONS = 5000;
  const MAX_LINES_SHOWN = 6;
  const TRIAL_COUNT = 2000; // Monte Carlo samples per line scored
  const CANDIDATE_CAP = 60; // lines eligible for scoring when more than this are base-lethal

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
  }

  function initLeaderRow() {
    const node = leaderTemplate.content.cloneNode(true);
    leaderRowContainer.appendChild(node);
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
  // object, so resolveLine() and defenderCanSurvive() have a single, stable
  // place to read from - including the color-specific Counter Events (see
  // the header comment for the exact mechanics and the simplifications
  // involved). Hand cards are spent on Events first (universal, then Red),
  // and whatever's left funds the generic average-value Counter budget;
  // Yellow's heal is capped by hand size but tracked independently of that
  // spend - a documented, deliberately conservative simplification.
  function readDefenderContext() {
    const { avgPerCard, handSize, deckSize, n2000, n1000 } = computeCounterBudget();
    const startingLife = Math.max(0, Number(defLifeInput.value) || 0);
    const color = defLeaderColorInput.value;
    const secondaryColor = defLeaderColor2Input.value || null;
    const donAvailable = Math.max(0, Math.floor(Number(defDonAvailableInput.value)) || 0);
    const blockerCount = Math.max(0, Math.floor(Number(defBlockerCountInput.value)) || 0);
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

  // Runs the combat resolution for one specific DON!! split across
  // `attackers` (parallel array `donAssignment`), in list order, against
  // the Leader - assuming the opponent plays NO Counter and NO Blocker.
  // Returns the play-by-play log, the base lethal/finalLife outcome, and
  // the list of battles (with their hit count and the Counter cost to
  // negate each one) for the defense-feasibility search below. Processes
  // every attacker (doesn't stop at the first lethal hit) so that search
  // has the full picture of what's negatable.
  function resolveLine(attackers, donAssignment, defender) {
    const log = [];
    const battles = [];
    let life = defender.startingLife;
    let lethal = false;

    for (let i = 0; i < attackers.length; i += 1) {
      const attacker = attackers[i];
      const donAssigned = donAssignment[i];
      const effectivePower = attacker.power + donAssigned * 1000;
      const donNote = donAssigned ? ` (+${donAssigned} DON)` : '';

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
      battles.push({ hits, costPower, banish: attacker.banish });

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

    return { log, lethal, finalLife: life, battles };
  }

  // Determines whether the defender can survive this line's battles using
  // their assumed Counter budget AND their fixed Blocker count together,
  // accounting for the budget growing mid-turn from non-Banished Life cards
  // reaching hand (see the header comment for why that's rules-accurate).
  // Each battle has three possible outcomes: Blocked (free, costs 1 of the
  // fixed Blocker count, no hits, no hand gain - since the attack never
  // reaches the Leader at all), Countered (spend its cost now, no hits, no
  // hand gain), or allowed to connect (hits count toward lethal, and -
  // unless Banished - its Life card grows the budget for battles later in
  // this same order).
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
  // Solved with a DP over (battle index, hits allowed through so far,
  // Blockers used so far) -> the MAXIMUM achievable running Counter budget
  // for that state. A higher budget can only ever help later decisions, so
  // only the max per state needs to be kept - this keeps the search
  // polynomial (battles × total hits × Blocker count) instead of
  // exponential, even though the decisions are sequential (budget earned
  // from one battle can't be spent on an earlier one, and a used Blocker
  // can't be reused).
  //
  // defender.counterBudget already includes color-specific Counter Event
  // power (universal + Red) via readDefenderContext(), and
  // defender.effectiveStartingLife already includes Yellow's assumed heal
  // uses - this function doesn't need to know about color/DON!! directly,
  // just these two pre-computed numbers plus the Blocker count.
  function defenderCanSurvive(battles, defender) {
    const { effectiveStartingLife, counterBudget, avgPerCard, blockerCount } = defender;
    const totalHits = battles.reduce((sum, b) => sum + b.hits, 0);
    if (totalHits <= effectiveStartingLife) return true; // not even lethal before any defense

    const maxBlocks = Math.min(blockerCount, battles.length); // blocking more battles than exist is pointless

    let dp = Array.from({ length: totalHits + 1 }, () => new Array(maxBlocks + 1).fill(-Infinity));
    dp[0][0] = counterBudget;

    for (const battle of battles) {
      const next = Array.from({ length: totalHits + 1 }, () => new Array(maxBlocks + 1).fill(-Infinity));
      for (let h = 0; h <= totalHits; h += 1) {
        for (let b = 0; b <= maxBlocks; b += 1) {
          const budget = dp[h][b];
          if (budget === -Infinity) continue;

          // Block: free, but uses up 1 of the fixed Blocker count.
          if (b < maxBlocks && budget > next[h][b + 1]) {
            next[h][b + 1] = budget;
          }

          // Counter: spend its cost now, no hits, no hand gain.
          if (budget >= battle.costPower && budget - battle.costPower > next[h][b]) {
            next[h][b] = budget - battle.costPower;
          }

          // Let it connect: hits count, and it grows the budget unless Banished.
          const nh = h + battle.hits;
          if (nh <= totalHits) {
            const gained = budget + (battle.banish ? 0 : battle.hits * avgPerCard);
            if (gained > next[nh][b]) next[nh][b] = gained;
          }
        }
      }
      dp = next;
    }

    for (let h = 0; h <= Math.min(effectiveStartingLife, totalHits); h += 1) {
      for (let b = 0; b <= maxBlocks; b += 1) {
        if (dp[h][b] !== -Infinity) return true;
      }
    }
    return false;
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
    const totalDon = Math.max(0, Math.floor(Number(donPoolInput.value)) || 0);

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
      const { log, lethal, finalLife, battles } = resolveLine(attackers, donAssignment, defender);
      const donUsed = donAssignment.reduce((sum, x) => sum + x, 0);
      return { donAssignment, donUsed, lethal, finalLife, log, battles };
    });

    // Score every base-lethal line's actual chance of staying lethal, via
    // Monte Carlo over real sampled hands (see estimateLethalPercent()).
    // Cheap to do for however many lines actually come up in normal use;
    // CANDIDATE_CAP only kicks in for pathologically large DON!! searches,
    // favoring the cheapest-DON!! lines so the cap doesn't change results
    // for the common case.
    const lethalResults = results.filter((r) => r.lethal);
    let scored = [];
    if (lethalResults.length) {
      const shortlist =
        lethalResults.length <= CANDIDATE_CAP
          ? lethalResults
          : lethalResults
              .slice()
              .sort((a, b) => a.donUsed - b.donUsed)
              .slice(0, CANDIDATE_CAP);
      const resourceSamples = buildResourceSamples(defender, TRIAL_COUNT);
      scored = shortlist
        .map((r) => ({ ...r, percent: estimateLethalPercent(r.battles, resourceSamples, defender) }))
        .sort((a, b) => b.percent - a.percent || a.donUsed - b.donUsed);
    } else {
      const best = results.slice().sort((a, b) => a.finalLife - b.finalLife || b.donUsed - a.donUsed)[0];
      if (best) scored = [{ ...best, percent: 0 }];
    }

    renderSearchResult({ attackers, scored, totalDon, truncated, defender });
  }

  function renderLine(attackers, result, totalDon) {
    const allocText = attackers.map((a, i) => `${escapeHtml(a.name)}: ${result.donAssignment[i]}`).join(', ');
    const logHtml = result.log.length
      ? `<ul class="lethal-log">${result.log.map((entry) => `<li class="lethal-log-${entry.type}">${escapeHtml(entry.text)}</li>`).join('')}</ul>`
      : '<p class="empty-state">No attacks landed.</p>';
    return `
      <div class="lethal-line">
        <p class="lethal-line-alloc">
          <span class="lethal-line-percent">${result.percent}% likely lethal</span>
          <strong>DON!! used (${result.donUsed} of ${totalDon}):</strong> ${allocText}
        </p>
        ${logHtml}
      </div>
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

    resultEl.classList.remove('lethal-result-yes', 'lethal-result-caution', 'lethal-result-no');
    resultEl.classList.add(top.percent >= 75 ? 'lethal-result-yes' : top.percent >= 25 ? 'lethal-result-caution' : 'lethal-result-no');

    const assumptionsNote = `<p class="lethal-hint">Based on ${defender.handSize} hand card${defender.handSize === 1 ? '' : 's'} and ${defender.startingLife} Life drawn from the deck described above, plus ${defender.blockerCount} Blocker${defender.blockerCount === 1 ? '' : 's'} and ${defender.donAvailable} DON!! (both known, not random) - percentages are a Monte Carlo estimate across ${TRIAL_COUNT.toLocaleString()} simulated hands, not a guarantee.</p>`;
    const truncNote = truncated
      ? `<p class="lethal-hint">DON!! search capped at ${MAX_DISTRIBUTIONS.toLocaleString()} allocations explored.</p>`
      : '';

    const headline =
      top.percent === 0
        ? `Not lethal — closest line leaves them at ${top.finalLife} Life`
        : `${top.percent}% likely lethal — recommended line uses ${top.donUsed} of ${totalDon} DON!!`;
    const icon = top.percent >= 75 ? '☠️' : top.percent >= 25 ? '⚠️' : top.percent > 0 ? '🤏' : '❌';

    resultEl.innerHTML = `
      <h2>${icon} ${headline}</h2>
      ${assumptionsNote}
      ${truncNote}
      ${renderLine(attackers, top, totalDon)}
      ${
        others.length
          ? `<h3>Other lines worth considering</h3><div class="lethal-lines-list">${others
              .map((r) => renderLine(attackers, r, totalDon))
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

  initLeaderRow();
  addAttackerRow();
  updateCounterBudgetPreview();
})();
