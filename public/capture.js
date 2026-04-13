(function () {
  'use strict';

  // Prevent double-init
  if (window.__tkocCaptureLoaded) return;
  window.__tkocCaptureLoaded = true;

  // Read API key from script tag
  var scripts = document.querySelectorAll('script[data-api-key]');
  var scriptTag = scripts[scripts.length - 1];
  var API_KEY = scriptTag ? scriptTag.getAttribute('data-api-key') : null;
  if (!API_KEY) {
    console.warn('[TKOC Capture] No data-api-key found on script tag.');
    return;
  }

  // Determine base URL from script src
  var BASE_URL = '';
  if (scriptTag && scriptTag.src) {
    var url = new URL(scriptTag.src);
    BASE_URL = url.origin;
  }

  var STORAGE_KEY = 'tkoc_capture_shown_' + API_KEY;
  var CONFIG = null;
  var popupShown = false;

  // Check localStorage — don't show if recently shown
  try {
    var lastShown = localStorage.getItem(STORAGE_KEY);
    if (lastShown) {
      var daysSince = (Date.now() - parseInt(lastShown, 10)) / (1000 * 60 * 60 * 24);
      if (daysSince < 30) return;
    }
  } catch (e) { /* localStorage unavailable */ }

  // Fetch widget config
  function fetchConfig(callback) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', BASE_URL + '/api/live-capture/widget-config?apiKey=' + encodeURIComponent(API_KEY));
    xhr.onload = function () {
      if (xhr.status === 200) {
        try {
          var data = JSON.parse(xhr.responseText);
          callback(data.config);
        } catch (e) {
          console.warn('[TKOC Capture] Failed to parse config.');
        }
      }
    };
    xhr.onerror = function () {
      console.warn('[TKOC Capture] Failed to fetch config.');
    };
    xhr.send();
  }

  // Inject CSS
  function injectStyles(config) {
    var color = config.primaryColor || '#7c3aed';
    var css = [
      '.tkoc-capture-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.3s ease;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
      '.tkoc-capture-overlay.tkoc-capture-visible{opacity:1}',
      '.tkoc-capture-popup{background:#fff;border-radius:16px;max-width:420px;width:90%;padding:32px;position:relative;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);transform:translateY(20px);transition:transform 0.3s ease}',
      '.tkoc-capture-overlay.tkoc-capture-visible .tkoc-capture-popup{transform:translateY(0)}',
      '.tkoc-capture-close{position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:8px;color:#9ca3af;font-size:20px;line-height:1}',
      '.tkoc-capture-close:hover{color:#374151}',
      '.tkoc-capture-logo{width:48px;height:48px;border-radius:12px;object-fit:contain;margin-bottom:12px}',
      '.tkoc-capture-brand{font-size:13px;font-weight:600;color:#6b7280;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em}',
      '.tkoc-capture-headline{font-size:22px;font-weight:700;color:#111827;margin:0 0 8px 0;line-height:1.3}',
      '.tkoc-capture-subtitle{font-size:14px;color:#6b7280;margin:0 0 20px 0;line-height:1.5}',
      '.tkoc-capture-incentive{display:inline-block;background:' + color + '15;color:' + color + ';font-size:13px;font-weight:600;padding:6px 14px;border-radius:99px;margin-bottom:16px}',
      '.tkoc-capture-form{display:flex;flex-direction:column;gap:12px}',
      '.tkoc-capture-input{width:100%;padding:12px 14px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:14px;color:#111827;background:#fff;outline:none;box-sizing:border-box;transition:border-color 0.2s}',
      '.tkoc-capture-input:focus{border-color:' + color + ';box-shadow:0 0 0 3px ' + color + '20}',
      '.tkoc-capture-input::placeholder{color:#9ca3af}',
      '.tkoc-capture-row{display:flex;gap:10px}',
      '.tkoc-capture-row .tkoc-capture-input{flex:1}',
      '.tkoc-capture-submit{width:100%;padding:13px;border:none;border-radius:10px;background:' + color + ';color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:opacity 0.2s}',
      '.tkoc-capture-submit:hover{opacity:0.9}',
      '.tkoc-capture-submit:disabled{opacity:0.5;cursor:not-allowed}',
      '.tkoc-capture-success{text-align:center;padding:24px 0}',
      '.tkoc-capture-success-icon{width:56px;height:56px;border-radius:50%;background:#10b98120;display:flex;align-items:center;justify-content:center;margin:0 auto 16px}',
      '.tkoc-capture-success-icon svg{width:28px;height:28px;color:#10b981}',
      '.tkoc-capture-success h3{font-size:18px;font-weight:700;color:#111827;margin:0 0 8px}',
      '.tkoc-capture-success p{font-size:14px;color:#6b7280;margin:0}',
      '.tkoc-capture-privacy{font-size:11px;color:#9ca3af;text-align:center;margin-top:8px}',
      '@media(max-width:480px){.tkoc-capture-popup{padding:24px;max-width:95%}.tkoc-capture-headline{font-size:18px}.tkoc-capture-row{flex-direction:column;gap:12px}}'
    ].join('\n');

    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Build and show popup
  function showPopup() {
    if (popupShown || !CONFIG) return;

    // Check mobile
    if (!CONFIG.showOnMobile && window.innerWidth < 768) return;

    popupShown = true;

    injectStyles(CONFIG);

    var overlay = document.createElement('div');
    overlay.className = 'tkoc-capture-overlay';
    overlay.setAttribute('id', 'tkoc-capture-overlay');

    var popup = document.createElement('div');
    popup.className = 'tkoc-capture-popup';

    // Close button
    var closeBtn = document.createElement('button');
    closeBtn.className = 'tkoc-capture-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = function () { hidePopup(); };
    popup.appendChild(closeBtn);

    // Logo
    if (CONFIG.brandLogo) {
      var logo = document.createElement('img');
      logo.className = 'tkoc-capture-logo';
      logo.src = CONFIG.brandLogo;
      logo.alt = CONFIG.brandName || '';
      popup.appendChild(logo);
    }

    // Brand name
    if (CONFIG.brandName) {
      var brand = document.createElement('div');
      brand.className = 'tkoc-capture-brand';
      brand.textContent = CONFIG.brandName;
      popup.appendChild(brand);
    }

    // Incentive badge
    if (CONFIG.incentiveText) {
      var incentive = document.createElement('div');
      incentive.className = 'tkoc-capture-incentive';
      incentive.textContent = CONFIG.incentiveText;
      popup.appendChild(incentive);
    }

    // Headline
    var headline = document.createElement('h2');
    headline.className = 'tkoc-capture-headline';
    headline.textContent = CONFIG.headlineText || 'Share your social media';
    popup.appendChild(headline);

    // Subtitle
    if (CONFIG.subtitleText) {
      var subtitle = document.createElement('p');
      subtitle.className = 'tkoc-capture-subtitle';
      subtitle.textContent = CONFIG.subtitleText;
      popup.appendChild(subtitle);
    }

    // Form
    var form = document.createElement('div');
    form.className = 'tkoc-capture-form';

    // Name + Email row
    var row1 = document.createElement('div');
    row1.className = 'tkoc-capture-row';
    var nameInput = createInput('text', 'Your name (optional)', 'tkoc-name');
    var emailInput = createInput('email', 'Email (optional)', 'tkoc-email');
    row1.appendChild(nameInput);
    row1.appendChild(emailInput);
    form.appendChild(row1);

    // Instagram
    var igInput = createInput('text', '@instagram handle', 'tkoc-instagram');
    form.appendChild(igInput);

    // TikTok
    var ttInput = createInput('text', '@tiktok handle', 'tkoc-tiktok');
    form.appendChild(ttInput);

    // YouTube (optional row)
    var ytInput = createInput('text', 'YouTube channel (optional)', 'tkoc-youtube');
    form.appendChild(ytInput);

    // Submit button
    var submitBtn = document.createElement('button');
    submitBtn.className = 'tkoc-capture-submit';
    submitBtn.textContent = 'Submit';
    submitBtn.type = 'button';
    form.appendChild(submitBtn);

    // Privacy text
    var privacy = document.createElement('div');
    privacy.className = 'tkoc-capture-privacy';
    privacy.textContent = 'We respect your privacy. Your data is handled securely.';
    form.appendChild(privacy);

    popup.appendChild(form);

    // Success state (hidden initially)
    var successDiv = document.createElement('div');
    successDiv.className = 'tkoc-capture-success';
    successDiv.style.display = 'none';
    successDiv.innerHTML =
      '<div class="tkoc-capture-success-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></div>' +
      '<h3>Thank you!</h3>' +
      '<p>We\'ve received your info. Stay tuned for exclusive offers!</p>';
    popup.appendChild(successDiv);

    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    // Animate in
    requestAnimationFrame(function () {
      overlay.classList.add('tkoc-capture-visible');
    });

    // Close on overlay click
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) hidePopup();
    });

    // Submit handler
    submitBtn.addEventListener('click', function () {
      var ig = igInput.value.trim();
      var tt = ttInput.value.trim();
      var yt = ytInput.value.trim();
      var em = emailInput.value.trim();
      var nm = nameInput.value.trim();

      if (!ig && !tt && !yt && !em) {
        igInput.style.borderColor = '#ef4444';
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';

      var payload = {
        apiKey: API_KEY,
        instagramHandle: ig || null,
        tiktokHandle: tt || null,
        youtubeHandle: yt || null,
        email: em || null,
        name: nm || null,
        pageUrl: window.location.href,
        referrer: document.referrer || null
      };

      var xhr = new XMLHttpRequest();
      xhr.open('POST', BASE_URL + '/api/live-capture/collect');
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = function () {
        // Show success regardless (don't expose errors to user)
        form.style.display = 'none';
        successDiv.style.display = 'block';

        // Store shown timestamp
        try {
          localStorage.setItem(STORAGE_KEY, Date.now().toString());
        } catch (e) { /* ignore */ }

        // Auto-close after 3 seconds
        setTimeout(function () { hidePopup(); }, 3000);
      };
      xhr.onerror = function () {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit';
      };
      xhr.send(JSON.stringify(payload));
    });
  }

  function hidePopup() {
    var overlay = document.getElementById('tkoc-capture-overlay');
    if (overlay) {
      overlay.classList.remove('tkoc-capture-visible');
      setTimeout(function () {
        overlay.parentNode && overlay.parentNode.removeChild(overlay);
      }, 300);
    }
    // Store shown timestamp even if dismissed
    try {
      localStorage.setItem(STORAGE_KEY, Date.now().toString());
    } catch (e) { /* ignore */ }
  }

  function createInput(type, placeholder, id) {
    var input = document.createElement('input');
    input.className = 'tkoc-capture-input';
    input.type = type;
    input.placeholder = placeholder;
    input.id = id;
    return input;
  }

  // Setup triggers
  function setupTriggers() {
    if (!CONFIG) return;

    var trigger = CONFIG.triggerType || 'exit_intent';

    switch (trigger) {
      case 'exit_intent':
        document.addEventListener('mouseout', function handler(e) {
          if (e.clientY <= 0) {
            document.removeEventListener('mouseout', handler);
            showPopup();
          }
        });
        // Fallback for mobile: show after 8 seconds
        if ('ontouchstart' in window) {
          setTimeout(showPopup, 8000);
        }
        break;

      case 'delay':
        var delay = (CONFIG.triggerDelay || 5) * 1000;
        setTimeout(showPopup, delay);
        break;

      case 'scroll':
        var threshold = CONFIG.triggerScroll || 50;
        window.addEventListener('scroll', function handler() {
          var scrollPct = (window.scrollY / (document.documentElement.scrollHeight - window.innerHeight)) * 100;
          if (scrollPct >= threshold) {
            window.removeEventListener('scroll', handler);
            showPopup();
          }
        });
        break;

      case 'manual':
        // Expose global function for manual trigger
        window.tkocCaptureShow = showPopup;
        break;

      default:
        setTimeout(showPopup, 5000);
    }
  }

  // Init
  fetchConfig(function (config) {
    CONFIG = config;
    if (CONFIG && CONFIG.isActive !== false) {
      setupTriggers();
    }
  });
})();
