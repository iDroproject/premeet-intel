/**
 * sidepanel.js
 *
 * Bright People Intel - Side Panel UI Controller
 *
 * Renders the full PersonData model from the response normalizer:
 *   - Profile header (avatar, name, title, company, location)
 *   - Stats (connections, followers, confidence)
 *   - About/bio
 *   - Experience timeline
 *   - Education list
 *   - Recent activity/posts
 *   - LinkedIn link
 *
 * Supports multi-person card stacking: each lookup result is cloned from
 * a <template> and prepended to a card stack (newest on top).
 */

'use strict';

const LOG_PREFIX = '[BPI][SidePanel]';

// -- DOM References --

const $ = (id) => document.getElementById(id);

const Views = {
  empty:     $('bpi-empty-state'),
  loading:   $('bpi-loading-state'),
  cardStack: $('bpi-card-stack'),
  error:     $('bpi-error-state'),
};

const El = {
  errorMessage:     $('bpi-error-message'),
  retryBtn:         $('bpi-retry'),
  loadingLabel:     $('bpi-loading-label'),
  progressFill:     $('bpi-progress-fill'),
  progressPercent:  $('bpi-progress-percent'),
  lookupNameText:   $('bpi-lookup-name-text'),
  pipeline:         $('bpi-pipeline'),
};

// -- State --

let lastPayload = null;

// -- View Management --

function showView(viewName) {
  Object.entries(Views).forEach(([key, el]) => {
    if (!el) return;
    el.classList.toggle('bpi-hidden', key !== viewName);
  });
}

// -- Helpers --

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function initialsFrom(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

function formatNumber(n) {
  if (n === null || n === undefined) return '--';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function confidenceLabel(level) {
  switch (level) {
    case 'high':   return { text: 'High', cls: 'bpi-confidence--high' };
    case 'medium': return { text: 'Med', cls: 'bpi-confidence--medium' };
    default:       return { text: 'Low', cls: 'bpi-confidence--low' };
  }
}

// -- Card Refs Helper --

/**
 * Build a refs object from a cloned card element by querying data-ref attrs.
 */
function getCardRefs(cardEl) {
  const r = (name) => cardEl.querySelector(`[data-ref="${name}"]`);
  return {
    avatar:              r('avatar'),
    name:                r('name'),
    jobTitle:            r('job-title'),
    company:             r('company'),
    location:            r('location'),
    statsRow:            r('stats-row'),
    connections:         r('connections'),
    followers:           r('followers'),
    confidence:          r('confidence'),
    statConfidence:      r('stat-confidence'),
    confidencePanel:     r('confidence-panel'),
    confidenceScore:     r('confidence-score'),
    confidenceBar:       r('confidence-bar'),
    confidenceCitations: r('confidence-citations'),
    bioSection:          r('bio-section'),
    bio:                 r('bio'),
    experienceSection:   r('experience-section'),
    experienceList:      r('experience-list'),
    educationSection:    r('education-section'),
    educationList:       r('education-list'),
    postsSection:        r('posts-section'),
    postsList:           r('posts-list'),
    linkedInSection:     r('linkedin-section'),
    linkedIn:            r('linkedin'),
    sourceBadge:         r('source-badge'),
    fetchedAt:           r('fetched-at'),
  };
}

// -- Card Render Functions --

function renderAvatar(refs, data) {
  const el = refs.avatar;
  if (!el) return;

  el.innerHTML = '';
  el.className = 'bpi-profile-header__avatar';

  if (data.avatarUrl && !data.avatarUrl.includes('/sc/h/')) {
    const img = document.createElement('img');
    img.src = data.avatarUrl;
    img.alt = data.name || '';
    img.className = 'bpi-avatar-img';
    img.onerror = () => {
      img.remove();
      el.textContent = initialsFrom(data.name);
      el.classList.add('bpi-avatar--initials');
    };
    el.appendChild(img);
  } else {
    el.textContent = initialsFrom(data.name);
    el.classList.add('bpi-avatar--initials');
  }
}

function renderIdentity(refs, data) {
  if (refs.name) refs.name.textContent = data.name || 'Unknown';
  if (refs.jobTitle) {
    refs.jobTitle.textContent = data.currentTitle || '';
    refs.jobTitle.hidden = !data.currentTitle;
  }
  if (refs.company) {
    refs.company.textContent = data.currentCompany || '';
    refs.company.hidden = !data.currentCompany;
  }
  if (refs.location) {
    refs.location.textContent = data.location || '';
    refs.location.hidden = !data.location;
  }
}

function renderStats(refs, data) {
  if (refs.connections) refs.connections.textContent = formatNumber(data.connections);
  if (refs.followers) refs.followers.textContent = formatNumber(data.followers);

  if (refs.confidence) {
    const conf = confidenceLabel(data._confidence);
    refs.confidence.textContent = conf.text;
    refs.confidence.className = 'bpi-stat__value bpi-confidence-dot ' + conf.cls;
  }

  const hasStats = data.connections || data.followers;
  if (refs.statsRow) refs.statsRow.hidden = !hasStats;
}

function renderConfidence(refs, data) {
  if (!refs.confidencePanel) return;

  const citations = data._confidenceCitations || [];
  const score = data._confidenceScore || 0;
  const maxScore = 12;

  if (refs.confidenceScore) refs.confidenceScore.textContent = `${score}/${maxScore}`;

  if (refs.confidenceBar) {
    const pct = Math.round((score / maxScore) * 100);
    refs.confidenceBar.style.width = `${pct}%`;
    refs.confidenceBar.className = 'bpi-confidence-panel__bar';
    if (data._confidence === 'high') refs.confidenceBar.classList.add('bpi-confidence-panel__bar--high');
    else if (data._confidence === 'medium') refs.confidenceBar.classList.add('bpi-confidence-panel__bar--medium');
    else refs.confidenceBar.classList.add('bpi-confidence-panel__bar--low');
  }

  if (refs.confidenceCitations) {
    refs.confidenceCitations.innerHTML = '';
    citations.forEach((c) => {
      const li = document.createElement('li');
      li.className = 'bpi-confidence-panel__citation';
      li.innerHTML = `<span class="bpi-confidence-panel__check">&#x2713;</span> ${escapeHtml(c.description)}`;
      refs.confidenceCitations.appendChild(li);
    });
  }

  if (refs.statConfidence && citations.length > 0) {
    refs.statConfidence.style.cursor = 'pointer';
    refs.statConfidence.onclick = () => {
      refs.confidencePanel.classList.toggle('bpi-hidden');
    };
  }
}

function renderBio(refs, data) {
  if (!refs.bioSection || !refs.bio) return;
  if (data.bio) {
    refs.bio.textContent = data.bio;
    refs.bioSection.hidden = false;
  } else {
    refs.bioSection.hidden = true;
  }
}

function renderExperience(refs, data) {
  if (!refs.experienceSection || !refs.experienceList) return;

  refs.experienceList.innerHTML = '';

  if (!data.experience || data.experience.length === 0) {
    refs.experienceSection.hidden = true;
    return;
  }

  refs.experienceSection.hidden = false;

  data.experience.forEach((exp) => {
    const item = document.createElement('div');
    item.className = 'bpi-timeline__item';

    let logoHtml = '';
    if (exp.companyLogoUrl) {
      logoHtml = `<img class="bpi-timeline__logo" src="${escapeHtml(exp.companyLogoUrl)}" alt="" onerror="this.style.display='none'" />`;
    }

    const dateRange = [exp.startDate, exp.endDate].filter(Boolean).join(' - ');

    item.innerHTML = `
      <div class="bpi-timeline__header">
        ${logoHtml}
        <div class="bpi-timeline__info">
          <p class="bpi-timeline__title">${escapeHtml(exp.title)}</p>
          <p class="bpi-timeline__company">${escapeHtml(exp.company)}</p>
          ${dateRange ? `<p class="bpi-timeline__date">${escapeHtml(dateRange)}</p>` : ''}
          ${exp.location ? `<p class="bpi-timeline__location">${escapeHtml(exp.location)}</p>` : ''}
        </div>
      </div>
      ${exp.description ? `<p class="bpi-timeline__desc">${escapeHtml(exp.description)}</p>` : ''}
    `;

    refs.experienceList.appendChild(item);
  });
}

function renderEducation(refs, data) {
  if (!refs.educationSection || !refs.educationList) return;

  refs.educationList.innerHTML = '';

  if (!data.education || data.education.length === 0) {
    refs.educationSection.hidden = true;
    return;
  }

  refs.educationSection.hidden = false;

  data.education.forEach((edu) => {
    const item = document.createElement('div');
    item.className = 'bpi-edu__item';

    let logoHtml = '';
    if (edu.logoUrl) {
      logoHtml = `<img class="bpi-edu__logo" src="${escapeHtml(edu.logoUrl)}" alt="" onerror="this.style.display='none'" />`;
    }

    const years = [edu.startYear, edu.endYear].filter(Boolean).join(' - ');
    const degreeLine = [edu.degree, edu.field].filter(Boolean).join(', ');

    item.innerHTML = `
      <div class="bpi-edu__header">
        ${logoHtml}
        <div class="bpi-edu__info">
          <p class="bpi-edu__institution">${escapeHtml(edu.institution)}</p>
          ${degreeLine ? `<p class="bpi-edu__degree">${escapeHtml(degreeLine)}</p>` : ''}
          ${years ? `<p class="bpi-edu__years">${escapeHtml(years)}</p>` : ''}
        </div>
      </div>
    `;

    refs.educationList.appendChild(item);
  });
}

function renderPosts(refs, data) {
  if (!refs.postsSection || !refs.postsList) return;

  refs.postsList.innerHTML = '';

  if (!data.recentPosts || data.recentPosts.length === 0) {
    refs.postsSection.hidden = true;
    return;
  }

  refs.postsSection.hidden = false;

  const posts = data.recentPosts.slice(0, 4);

  posts.forEach((post) => {
    const item = document.createElement('a');
    item.className = 'bpi-post__item';
    item.href = post.link || '#';
    item.target = '_blank';
    item.rel = 'noopener noreferrer';

    let imgHtml = '';
    if (post.imageUrl) {
      imgHtml = `<img class="bpi-post__img" src="${escapeHtml(post.imageUrl)}" alt="" onerror="this.style.display='none'" />`;
    }

    item.innerHTML = `
      ${imgHtml}
      <div class="bpi-post__content">
        <p class="bpi-post__interaction">${escapeHtml(post.interaction)}</p>
        <p class="bpi-post__title">${escapeHtml(post.title ? post.title.slice(0, 120) + (post.title.length > 120 ? '...' : '') : '')}</p>
      </div>
    `;

    refs.postsList.appendChild(item);
  });
}

function renderLinkedIn(refs, data) {
  if (!refs.linkedInSection || !refs.linkedIn) return;
  if (data.linkedinUrl && /^https?:\/\/(www\.)?linkedin\.com\//i.test(data.linkedinUrl)) {
    refs.linkedIn.href = data.linkedinUrl;
    refs.linkedInSection.hidden = false;
  } else {
    refs.linkedInSection.hidden = true;
  }
}

function renderFooter(refs, data) {
  if (refs.sourceBadge) {
    const sourceMap = {
      'brightdata-url': 'LinkedIn',
      'brightdata-name': 'Search',
      'brightdata-deep': 'Deep Lookup',
      'brightdata-serp-enriched': 'SERP + LinkedIn',
      'cache': 'Cached',
      'mock': 'Demo',
      'error': 'Error',
    };
    refs.sourceBadge.textContent = sourceMap[data._source] || data._source || 'Unknown';
  }

  if (refs.fetchedAt && data._fetchedAt) {
    const d = new Date(data._fetchedAt);
    refs.fetchedAt.textContent = `Fetched ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    refs.fetchedAt.dateTime = d.toISOString();
  }
}

// -- Progress Render --

function renderProgress(progressPayload) {
  const { percent, personName, stepsState, label } = progressPayload;

  if (El.progressFill) {
    El.progressFill.style.width = `${percent}%`;
    // Update ARIA on the progressbar container
    const progressEl = El.progressFill.closest('[role="progressbar"]');
    if (progressEl) progressEl.setAttribute('aria-valuenow', percent);
  }
  if (El.progressPercent) {
    El.progressPercent.textContent = `${percent}%`;
  }

  if (El.lookupNameText && personName) {
    El.lookupNameText.textContent = `Looking up ${personName}...`;
  }

  if (El.pipeline && stepsState) {
    stepsState.forEach(step => {
      const stepEl = El.pipeline.querySelector(`[data-step="${step.id}"]`);
      if (!stepEl) return;

      stepEl.className = `bpi-pipeline__step bpi-pipeline__step--${step.status}`;

      const statusEl = stepEl.querySelector('.bpi-pipeline__status');
      if (statusEl) {
        const icons = { pending: '', active: '', completed: '\u2713', failed: '\u2717', skipped: '\u2014' };
        statusEl.textContent = icons[step.status] || '';
      }
    });
  }

  if (El.loadingLabel && label) {
    El.loadingLabel.textContent = label;
  }
}

// -- Main Render --

/**
 * Clone the person card template, populate it with data, and prepend
 * to the card stack (newest result on top).
 */
function renderPersonCard(data) {
  console.log(LOG_PREFIX, 'Rendering person card for:', data.name);

  if (data._error) {
    showError(data._error);
    return;
  }

  const template = document.getElementById('bpi-person-card-template');
  if (!template) {
    console.error(LOG_PREFIX, 'Person card template not found');
    showError('UI error: card template missing');
    return;
  }

  const cardEl = template.content.firstElementChild.cloneNode(true);
  const refs = getCardRefs(cardEl);

  renderAvatar(refs, data);
  renderIdentity(refs, data);
  renderStats(refs, data);
  renderConfidence(refs, data);
  renderBio(refs, data);
  renderExperience(refs, data);
  renderEducation(refs, data);
  renderPosts(refs, data);
  renderLinkedIn(refs, data);
  renderFooter(refs, data);

  // Prepend newest card to stack
  Views.cardStack.prepend(cardEl);
  showView('cardStack');
}

function showError(message) {
  if (El.errorMessage) {
    El.errorMessage.textContent = message || 'Could not load background information. Please try again.';
  }
  showView('error');
}

// -- Retry --

El.retryBtn?.addEventListener('click', () => {
  if (!lastPayload) {
    showView('empty');
    return;
  }

  console.log(LOG_PREFIX, 'Retry requested for:', lastPayload.name);
  showView('loading');

  chrome.runtime.sendMessage(
    { type: 'FETCH_PERSON_BACKGROUND', payload: lastPayload },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error(LOG_PREFIX, 'Retry failed:', chrome.runtime.lastError.message);
        showError('Could not reach the background service. Please try again.');
      }
    }
  );
});

// -- Message Listener --

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  if (sender.id && sender.id !== chrome.runtime.id) return false;

  console.log(LOG_PREFIX, 'Received message:', message.type);

  switch (message.type) {
    case 'FETCH_PERSON_BACKGROUND': {
      lastPayload = message.payload || null;
      if (El.loadingLabel && lastPayload?.name) {
        El.loadingLabel.textContent = `Looking up ${lastPayload.name}...`;
      }
      // Reset progress UI
      if (El.progressFill) El.progressFill.style.width = '0%';
      if (El.progressPercent) El.progressPercent.textContent = '0%';
      if (El.lookupNameText && lastPayload?.name) {
        El.lookupNameText.textContent = `Looking up ${lastPayload.name}...`;
      }
      if (El.pipeline) {
        El.pipeline.querySelectorAll('.bpi-pipeline__step').forEach(el => {
          el.className = 'bpi-pipeline__step bpi-pipeline__step--pending';
          const statusEl = el.querySelector('.bpi-pipeline__status');
          if (statusEl) statusEl.textContent = '';
        });
      }
      showView('loading');
      sendResponse({ ok: true });
      break;
    }

    case 'FETCH_PROGRESS': {
      const progressPayload = message.payload;
      console.log(LOG_PREFIX, 'Fetch progress:', progressPayload?.label);
      if (progressPayload?.stepsState) {
        renderProgress(progressPayload);
      } else if (progressPayload?.label && El.loadingLabel) {
        El.loadingLabel.textContent = progressPayload.label;
      }
      sendResponse({ ok: true });
      break;
    }

    case 'PERSON_BACKGROUND_RESULT': {
      const data = message.payload;
      if (!data) {
        showError('Received empty response from service.');
        sendResponse({ ok: false });
        break;
      }

      try {
        renderPersonCard(data);
        sendResponse({ ok: true });
      } catch (err) {
        console.error(LOG_PREFIX, 'Error rendering person card:', err);
        showError('Failed to display background information.');
        sendResponse({ ok: false, error: err.message });
      }
      break;
    }

    default:
      return false;
  }

  return true;
});

// -- Manual Search --

function handleManualSearch(name) {
  const trimmed = name.trim();
  if (!trimmed) return;

  console.log(LOG_PREFIX, 'Manual search for:', trimmed);

  const payload = { name: trimmed, email: null, company: null };
  lastPayload = payload;

  if (El.loadingLabel) {
    El.loadingLabel.textContent = `Looking up ${trimmed}...`;
  }
  showView('loading');

  chrome.runtime.sendMessage(
    { type: 'FETCH_PERSON_BACKGROUND', payload },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error(LOG_PREFIX, 'Manual search message failed:', chrome.runtime.lastError.message);
        showError('Could not reach the background service. Please try again.');
      } else if (response && !response.ok) {
        console.warn(LOG_PREFIX, 'Manual search rejected by service worker:', response.error);
        showError(response.error || 'Could not start the search. Please try again.');
      }
    }
  );
}

function wireManualSearch(inputId, buttonId) {
  const inputEl = $(inputId);
  const btnEl   = $(buttonId);

  if (!inputEl || !btnEl) return;

  btnEl.addEventListener('click', () => {
    handleManualSearch(inputEl.value);
    inputEl.value = '';
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      handleManualSearch(inputEl.value);
      inputEl.value = '';
    }
  });
}

// -- Init --

(function init() {
  console.log(LOG_PREFIX, 'Side panel initialised');
  wireManualSearch('bpi-search-input-empty', 'bpi-search-btn-empty');
  wireManualSearch('bpi-search-input-error', 'bpi-search-btn-error');
  showView('empty');
})();
