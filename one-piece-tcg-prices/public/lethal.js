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
//     from the Leader, and can only block once per turn.
//   - DON!!: each attached DON gives +1000 power, for the turn only.
//   - Double Attack: NOT "2x power" - it deals damage as two separate
//     Life-card hits, each its own reveal/Trigger opportunity.
//   - Banish: the Life card removed goes straight to the trash, unseen -
//     no Trigger, ever, for that hit specifically.
//   - Loss condition: reaching 0 Life isn't itself a loss - the player
//     loses when they take a successful hit WHILE ALREADY at 0 Life.
//
// NOT modeled yet (see the caveat text in index.html): true probability
// from hidden information (opponent's actual hand/deck Counter odds,
// what a given un-Banished Trigger would actually do). The "Assumed
// opponent Counter here" field is a manual stand-in for that - stress-test
// a specific scenario by setting it, rather than this app guessing at
// percentages.

(function () {
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
    return {
      isLeader,
      name: isLeader ? 'Your Leader' : row.querySelector('.lethal-atk-name')?.value.trim() || 'Character',
      attacksThisTurn: isLeader ? row.querySelector('.lethal-atk-attacks').checked : true,
      power: Number(row.querySelector('.lethal-atk-power').value) || 0,
      don: Number(row.querySelector('.lethal-atk-don').value) || 0,
      double: row.querySelector('.lethal-atk-double').checked,
      banish: row.querySelector('.lethal-atk-banish').checked,
      target: row.querySelector('.lethal-atk-target').value,
      counter: Number(row.querySelector('.lethal-atk-counter').value) || 0,
    };
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function calculate() {
    const defenderLeaderPower = Number(defLeaderPowerInput.value) || 0;
    const startingLife = Math.max(0, Number(defLifeInput.value) || 0);
    const blockers = currentBlockers();
    const blockersById = new Map(blockers.map((b) => [b.id, b]));

    const attackers = [
      readAttackerRow(leaderRowContainer.querySelector('.lethal-attacker-row'), true),
      ...[...attackersList.querySelectorAll('.lethal-attacker-row')].map((row) => readAttackerRow(row, false)),
    ].filter((a) => a.attacksThisTurn);

    const usedBlockerIds = new Set();
    const log = [];
    let life = startingLife;
    let lethal = false;

    for (const attacker of attackers) {
      if (lethal) break;

      const effectivePower = attacker.power + attacker.don * 1000;
      let target = attacker.target;

      if (target !== 'leader') {
        const blocker = blockersById.get(target);
        if (!blocker) {
          target = 'leader'; // blocker row was removed after this row was set up
        } else if (usedBlockerIds.has(blocker.id)) {
          log.push({
            type: 'note',
            text: `${attacker.name} was set to be blocked by ${blocker.name}, but that Blocker was already used earlier this turn - attacking the Leader directly instead.`,
          });
          target = 'leader';
        } else {
          const defPower = blocker.power + attacker.counter;
          if (effectivePower >= defPower) {
            usedBlockerIds.add(blocker.id);
            log.push({
              type: 'ko',
              text: `${attacker.name} (${effectivePower.toLocaleString()}) K.O.'s ${blocker.name} (${defPower.toLocaleString()}). No Life lost.`,
            });
          } else {
            log.push({
              type: 'fail',
              text: `${attacker.name} (${effectivePower.toLocaleString()}) doesn't get through ${blocker.name} (${defPower.toLocaleString()}). No Life lost.`,
            });
          }
          continue;
        }
      }

      if (target === 'leader') {
        const defPower = defenderLeaderPower + attacker.counter;
        if (effectivePower < defPower) {
          log.push({
            type: 'fail',
            text: `${attacker.name} (${effectivePower.toLocaleString()}) doesn't get through the Leader (${defPower.toLocaleString()}). No Life lost.`,
          });
          continue;
        }

        const hits = attacker.double ? 2 : 1;
        for (let h = 0; h < hits; h += 1) {
          if (life <= 0) {
            lethal = true;
            log.push({
              type: 'lethal',
              text: `${attacker.name} hits the Leader while Life is already 0 - LETHAL.`,
            });
            break;
          }
          life -= 1;
          const banishNote = attacker.banish ? 'Banished - no Trigger' : 'revealed - Trigger may activate';
          log.push({
            type: 'hit',
            text: `${attacker.name} hits the Leader (${effectivePower.toLocaleString()} vs ${defPower.toLocaleString()}). Life card removed (${banishNote}). Life now ${life}.`,
          });
        }
      }
    }

    renderResult({ lethal, startingLife, finalLife: life, log });
  }

  function renderResult({ lethal, startingLife, finalLife, log }) {
    resultEl.hidden = false;
    resultEl.classList.toggle('lethal-result-yes', lethal);
    resultEl.classList.toggle('lethal-result-no', !lethal);

    const headline = lethal
      ? '☠️ LETHAL — this attack plan defeats the opponent'
      : `Not lethal — opponent survives with ${finalLife} Life remaining (started at ${startingLife})`;

    const logHtml = log.length
      ? `<ul class="lethal-log">${log.map((entry) => `<li class="lethal-log-${entry.type}">${escapeHtml(entry.text)}</li>`).join('')}</ul>`
      : '<p class="empty-state">No attacks were planned.</p>';

    resultEl.innerHTML = `<h2>${headline}</h2>${logHtml}`;
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  addBlockerBtn.addEventListener('click', addBlockerRow);
  addAttackerBtn.addEventListener('click', addAttackerRow);
  calculateBtn.addEventListener('click', calculate);

  initLeaderRow();
  addBlockerRow();
  addAttackerRow();
})();
