/**
 * sidepanel.js
 *
 * Meeting Intel - Side Panel UI Controller
 *
 * Renders the full PersonData model from the response normalizer:
 *   - Profile header (avatar, name, title, company, location)
 *   - Stats (connections, followers, confidence)
 *   - About/bio
 *   - Experience timeline
 *   - Education list
 *   - Recent activity/posts
 *   - LinkedIn link
 */

'use strict';

const LOG_PREFIX = '[Meeting Intel][SidePanel]';

// -- DOM References --

const $ = (id) => document.getElementById(id);

const Views = {
  empty:   $('mi-empty-state'),
  loading: $('mi-loading-state'),
  card:    $('mi-person-card'),
  error:   $('mi-error-state'),
};

const El = {
  avatar:           $('mi-avatar'),
  name:             $('mi-name'),
  jobTitle:         $('mi-job-title'),
  company:          $('mi-company'),
  location:         $('mi-location'),
  statsRow:         $('mi-stats-row'),
  connections:      $('mi-connections'),
  followers:        $('mi-followers'),
  confidence:       $('mi-confidence'),
  bioSection:       $('mi-bio-section'),
  bio:              $('mi-bio'),
  experienceSection: $('mi-experience-section'),
  experienceList:   $('mi-experience-list'),
  educationSection: $('mi-education-section'),
  educationList:    $('mi-education-list'),
  postsSection:     $('mi-posts-section'),
  postsList:        $('mi-posts-list'),
  linkedInSection:  $('mi-linkedin-section'),
  linkedIn:         $('mi-linkedin'),
  sourceBadge:      $('mi-source-badge'),
  fetchedAt:        $('mi-fetched-at'),
  errorMessage:     $('mi-error-message'),
  retryBtn:         $('mi-retry'),
  loadingLabel:     $('mi-loading-label'),
};

// -- State --

let lastPayload = null;

// -- View Management --

function showView(viewName) {
  Object.entries(Views).forEach(([key, el]) => {
    if (!el) return;
    el.classList.toggle('mi-hidden', key !== viewName);
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
    case 'high':   return { text: 'High', cls: 'mi-confidence--high' };
    case 'medium': return { text: 'Med', cls: 'mi-confidence--medium' };
    default:       return { text: 'Low', cls: 'mi-confidence--low' };
  }
}

// -- Render Functions --

function renderAvatar(data) {
  const el = El.avatar;
  if (!el) return;

  el.innerHTML = '';
  el.className = 'mi-profile-header__avatar';

  if (data.avatarUrl && !data.avatarUrl.includes('/sc/h/')) {
    // Real avatar image (skip LinkedIn default placeholder URLs)
    const img = document.createElement('img');
    img.src = data.avatarUrl;
    img.alt = data.name || '';
    img.className = 'mi-avatar-img';
    img.onerror = () => {
      img.remove();
      el.textContent = initialsFrom(data.name);
      el.classList.add('mi-avatar--initials');
    };
    el.appendChild(img);
  } else {
    el.textContent = initialsFrom(data.name);
    el.classList.add('mi-avatar--initials');
  }
}

function renderIdentity(data) {
  if (El.name) El.name.textContent = data.name || 'Unknown';
  if (El.jobTitle) {
    El.jobTitle.textContent = data.currentTitle || '';
    El.jobTitle.hidden = !data.currentTitle;
  }
  if (El.company) {
    El.company.textContent = data.currentCompany || '';
    El.company.hidden = !data.currentCompany;
  }
  if (El.location) {
    El.location.textContent = data.location || '';
    El.location.hidden = !data.location;
  }
}

function renderStats(data) {
  if (El.connections) El.connections.textContent = formatNumber(data.connections);
  if (El.followers) El.followers.textContent = formatNumber(data.followers);

  if (El.confidence) {
    const conf = confidenceLabel(data._confidence);
    El.confidence.textContent = conf.text;
    El.confidence.className = 'mi-stat__value mi-confidence-dot ' + conf.cls;
  }

  // Hide stats row if no meaningful data
  const hasStats = data.connections || data.followers;
  if (El.statsRow) El.statsRow.hidden = !hasStats;
}

function renderBio(data) {
  if (!El.bioSection || !El.bio) return;
  if (data.bio) {
    El.bio.textContent = data.bio;
    El.bioSection.hidden = false;
  } else {
    El.bioSection.hidden = true;
  }
}

function renderExperience(data) {
  if (!El.experienceSection || !El.experienceList) return;

  El.experienceList.innerHTML = '';

  if (!data.experience || data.experience.length === 0) {
    El.experienceSection.hidden = true;
    return;
  }

  El.experienceSection.hidden = false;

  data.experience.forEach((exp) => {
    const item = document.createElement('div');
    item.className = 'mi-timeline__item';

    let logoHtml = '';
    if (exp.companyLogoUrl) {
      logoHtml = `<img class="mi-timeline__logo" src="${escapeHtml(exp.companyLogoUrl)}" alt="" onerror="this.style.display='none'" />`;
    }

    const dateRange = [exp.startDate, exp.endDate].filter(Boolean).join(' - ');

    item.innerHTML = `
      <div class="mi-timeline__header">
        ${logoHtml}
        <div class="mi-timeline__info">
          <p class="mi-timeline__title">${escapeHtml(exp.title)}</p>
          <p class="mi-timeline__company">${escapeHtml(exp.company)}</p>
          ${dateRange ? `<p class="mi-timeline__date">${escapeHtml(dateRange)}</p>` : ''}
          ${exp.location ? `<p class="mi-timeline__location">${escapeHtml(exp.location)}</p>` : ''}
        </div>
      </div>
      ${exp.description ? `<p class="mi-timeline__desc">${escapeHtml(exp.description)}</p>` : ''}
    `;

    El.experienceList.appendChild(item);
  });
}

function renderEducation(data) {
  if (!El.educationSection || !El.educationList) return;

  El.educationList.innerHTML = '';

  if (!data.education || data.education.length === 0) {
    El.educationSection.hidden = true;
    return;
  }

  El.educationSection.hidden = false;

  data.education.forEach((edu) => {
    const item = document.createElement('div');
    item.className = 'mi-edu__item';

    let logoHtml = '';
    if (edu.logoUrl) {
      logoHtml = `<img class="mi-edu__logo" src="${escapeHtml(edu.logoUrl)}" alt="" onerror="this.style.display='none'" />`;
    }

    const years = [edu.startYear, edu.endYear].filter(Boolean).join(' - ');
    const degreeLine = [edu.degree, edu.field].filter(Boolean).join(', ');

    item.innerHTML = `
      <div class="mi-edu__header">
        ${logoHtml}
        <div class="mi-edu__info">
          <p class="mi-edu__institution">${escapeHtml(edu.institution)}</p>
          ${degreeLine ? `<p class="mi-edu__degree">${escapeHtml(degreeLine)}</p>` : ''}
          ${years ? `<p class="mi-edu__years">${escapeHtml(years)}</p>` : ''}
        </div>
      </div>
    `;

    El.educationList.appendChild(item);
  });
}

function renderPosts(data) {
  if (!El.postsSection || !El.postsList) return;

  El.postsList.innerHTML = '';

  if (!data.recentPosts || data.recentPosts.length === 0) {
    El.postsSection.hidden = true;
    return;
  }

  El.postsSection.hidden = false;

  // Show max 4 posts
  const posts = data.recentPosts.slice(0, 4);

  posts.forEach((post) => {
    const item = document.createElement('a');
    item.className = 'mi-post__item';
    item.href = post.link || '#';
    item.target = '_blank';
    item.rel = 'noopener noreferrer';

    let imgHtml = '';
    if (post.imageUrl) {
      imgHtml = `<img class="mi-post__img" src="${escapeHtml(post.imageUrl)}" alt="" onerror="this.style.display='none'" />`;
    }

    item.innerHTML = `
      ${imgHtml}
      <div class="mi-post__content">
        <p class="mi-post__interaction">${escapeHtml(post.interaction)}</p>
        <p class="mi-post__title">${escapeHtml(post.title ? post.title.slice(0, 120) + (post.title.length > 120 ? '...' : '') : '')}</p>
      </div>
    `;

    El.postsList.appendChild(item);
  });
}

function renderLinkedIn(data) {
  if (!El.linkedInSection || !El.linkedIn) return;
  if (data.linkedinUrl) {
    El.linkedIn.href = data.linkedinUrl;
    El.linkedInSection.hidden = false;
  } else {
    El.linkedInSection.hidden = true;
  }
}

function renderFooter(data) {
  if (El.sourceBadge) {
    const sourceMap = {
      'brightdata-url': 'LinkedIn',
      'brightdata-name': 'Search',
      'cache': 'Cached',
      'mock': 'Demo',
      'error': 'Error',
    };
    El.sourceBadge.textContent = sourceMap[data._source] || data._source || 'Unknown';
  }

  if (El.fetchedAt && data._fetchedAt) {
    const d = new Date(data._fetchedAt);
    El.fetchedAt.textContent = `Fetched ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    El.fetchedAt.dateTime = d.toISOString();
  }
}

// -- Main Render --

function renderPersonCard(data) {
  console.log(LOG_PREFIX, 'Rendering person card for:', data.name);

  // Check for error response
  if (data._error) {
    showError(data._error);
    return;
  }

  renderAvatar(data);
  renderIdentity(data);
  renderStats(data);
  renderBio(data);
  renderExperience(data);
  renderEducation(data);
  renderPosts(data);
  renderLinkedIn(data);
  renderFooter(data);

  showView('card');
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
      showView('loading');
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

// -- Init --

(function init() {
  console.log(LOG_PREFIX, 'Side panel initialised');
  showView('empty');
})();
