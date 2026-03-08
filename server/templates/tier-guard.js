/**
 * Parlay King — Tier Guard v2.0
 * Handles: tier detection, PayPal payment success, dashboard gating
 * Business: Glenoring@gmail.com | Merchant: 8PRMK8D9JEW9Q
 */
(function() {
  'use strict';

  // ── Tier constants ──────────────────────────────────────────────────────────
  var TIERS = { FREE: 'free', VIP: 'vip', PRO: 'pro', LIFETIME: 'lifetime' };
  var PRO_TIERS = [TIERS.VIP, TIERS.PRO, TIERS.LIFETIME];

  // ── Get current tier from localStorage ─────────────────────────────────────
  function getCurrentTier() {
    var tier = localStorage.getItem('userTier') || 'free';
    // Check subscription expiry for monthly plans
    var plan = localStorage.getItem('subscription_plan') || '';
    var expiry = localStorage.getItem('subscription_expiry');
    if (expiry && plan !== 'lifetime') {
      var now = new Date().getTime();
      var exp = new Date(expiry).getTime();
      if (now > exp) {
        // Subscription expired — reset to free
        localStorage.setItem('userTier', 'free');
        localStorage.removeItem('subscription_active');
        localStorage.removeItem('subscription_plan');
        localStorage.removeItem('subscription_expiry');
        return 'free';
      }
    }
    return tier;
  }

  // ── Check if user has pro access ────────────────────────────────────────────
  function isProUser() {
    return PRO_TIERS.indexOf(getCurrentTier()) !== -1;
  }

  // ── Handle PayPal payment success redirect ──────────────────────────────────
  function handlePaymentSuccess(plan) {
    var tier, planName, expiryDate;
    var now = new Date();

    if (plan === 'vip-monthly' || plan === 'vip_monthly') {
      tier = 'vip';
      planName = 'VIP Elite';
      expiryDate = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()).toISOString();
    } else if (plan === 'pro-streamz-monthly' || plan === 'pro_monthly') {
      tier = 'pro';
      planName = 'Pro Streamz 4K';
      expiryDate = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()).toISOString();
    } else if (plan === 'lifetime' || plan === 'lifetime-royalty') {
      tier = 'lifetime';
      planName = 'Lifetime Royalty';
      expiryDate = null; // Never expires
    } else {
      tier = 'vip';
      planName = 'VIP Elite';
      expiryDate = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()).toISOString();
    }

    // Store tier in localStorage
    localStorage.setItem('userTier', tier);
    localStorage.setItem('subscription_plan', plan);
    localStorage.setItem('subscription_active', 'true');
    if (expiryDate) localStorage.setItem('subscription_expiry', expiryDate);

    // Store user object
    var userId = tier.toUpperCase() + '_User_' + Date.now();
    var userObj = {
      id: userId,
      email: userId + '@parlayking.vip',
      tier: tier,
      vipMember: true,
      vipStatus: 'active',
      vipPlan: plan,
      vipUpgradeDate: now.toISOString(),
      loginTime: now.toISOString()
    };
    localStorage.setItem('currentUser', JSON.stringify(userObj));
    localStorage.setItem('rememberMe', 'true');

    // Show success modal
    showPaymentSuccessModal(planName, tier);
  }

  // -- Show payment success -- redirects to registration form
  function showPaymentSuccessModal(planName, tier) {
    var overlay = document.createElement('div');
    overlay.id = 'pk-payment-success-modal';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.92);display:flex;justify-content:center;align-items:center;z-index:99999;';
    var tierColor = (tier === 'lifetime') ? '#00cc66' : '#d4af37';
    var box = document.createElement('div');
    box.style.cssText = 'background:linear-gradient(135deg,#0f1419 0%,#1a2332 100%);border:3px solid ' + tierColor + ';border-radius:16px;padding:2.5rem;max-width:480px;width:90%;text-align:center;color:white;';
    box.innerHTML = '<div style="font-size:3rem;margin-bottom:1rem;">&#128081;</div>'
      + '<h1 style="font-size:1.8rem;margin-bottom:0.5rem;color:' + tierColor + ';">Payment Confirmed!</h1>'
      + '<p style="font-size:1.1rem;margin-bottom:0.5rem;color:#fff;">Welcome to <strong style="color:' + tierColor + ';">' + planName + '</strong>!</p>'
      + '<p style="font-size:0.9rem;color:#aaa;margin-bottom:1.5rem;">Create your account to access your dashboard and log back in anytime.</p>'
      + '<button id="pk-go-register" style="background:' + tierColor + ';color:#0f1419;border:none;padding:14px 32px;border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer;width:100%;margin-bottom:12px;">&#9989; Create My Account</button>'
      + '<p style="color:#666;font-size:0.8rem;">Takes 30 seconds - secure your access now</p>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    document.getElementById('pk-go-register').addEventListener('click', function() {
      overlay.remove();
      if (typeof showPage === 'function') showPage('register');
    });
  }


  // ── Apply tier gating to NBA/MLS/Power Pick tabs ────────────────────────────
  function applyTierGating() {
    var pro = isProUser();
    var tier = getCurrentTier();

    // Update tab buttons with lock icons for free users
    var mlsBtn = document.querySelector('.tab-btn[onclick*="mls"]');
    var nbaBtn = document.getElementById('nba-tab-btn') || document.querySelector('.tab-btn[onclick*="nba"]');
    var ppBtn = document.getElementById('powerpick-tab-btn') || document.querySelector('.tab-btn[onclick*="powerpick"]');

    if (!pro) {
      if (mlsBtn && !mlsBtn.querySelector('.lock-icon')) {
        mlsBtn.innerHTML = '🇺🇸 3-Leg MLS <span class="lock-icon" style="opacity:0.7;">🔒</span>';
        mlsBtn.onclick = function(e) { e.preventDefault(); showUpgradePrompt('mls'); };
      }
      if (nbaBtn && !nbaBtn.querySelector('.lock-icon')) {
        nbaBtn.innerHTML = '🏀 3-Leg NBA <span class="lock-icon" style="opacity:0.7;">🔒</span>';
        nbaBtn.onclick = function(e) { e.preventDefault(); showUpgradePrompt('nba'); };
      }
      if (ppBtn && !ppBtn.querySelector('.lock-icon')) {
        ppBtn.innerHTML = '⚡ Power Pick <span class="lock-icon" style="opacity:0.7;">🔒</span>';
        ppBtn.onclick = function(e) { e.preventDefault(); showUpgradePrompt('powerpick'); };
      }
    } else {
      // Remove locks for pro users
      if (mlsBtn) {
        mlsBtn.innerHTML = '🇺🇸 3-Leg MLS';
        mlsBtn.onclick = function() { if (typeof switchTab === 'function') switchTab('mls'); };
      }
      if (nbaBtn) {
        nbaBtn.innerHTML = '🏀 3-Leg NBA';
        nbaBtn.onclick = function() { if (typeof switchTab === 'function') switchTab('nba'); };
      }
      if (ppBtn) {
        ppBtn.innerHTML = '⚡ Power Pick';
        ppBtn.onclick = function() { if (typeof switchTab === 'function') switchTab('powerpick'); };
      }
    }

    // Update account page with current tier
    updateAccountPage(tier);

    // Update pricing page buttons
    updatePricingPage(tier);
  }

  // ── Show upgrade prompt modal ────────────────────────────────────────────────
  function showUpgradePrompt(tab) {
    var tabNames = { mls: 'MLS Picks', nba: 'NBA 3-Leg Parlay', powerpick: 'Power Pick' };
    var tabName = tabNames[tab] || 'Premium Content';

    var overlay = document.createElement('div');
    overlay.id = 'pk-upgrade-modal';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.88);display:flex;justify-content:center;align-items:center;z-index:99999;';
    overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

    var box = document.createElement('div');
    box.style.cssText = 'background:linear-gradient(135deg,#0f1419 0%,#1a2332 100%);border:2px solid #d4af37;border-radius:16px;padding:2rem;max-width:420px;width:90%;text-align:center;color:white;box-shadow:0 20px 60px rgba(212,175,55,0.3);';
    box.innerHTML = '<div style="font-size:2.5rem;margin-bottom:1rem;">🔒</div>'
      + '<h2 style="color:#d4af37;margin-bottom:0.5rem;">' + tabName + '</h2>'
      + '<p style="color:#888;font-size:0.9rem;margin-bottom:1.5rem;">This content is available to Pro and Lifetime Royalty members.</p>'
      + '<div style="display:flex;flex-direction:column;gap:12px;margin-bottom:1.5rem;">'
      + '<button onclick="document.getElementById(\'pk-upgrade-modal\').remove(); if(typeof showPage===\'function\') showPage(\'pricing\');" style="background:#d4af37;color:#0f1419;border:none;padding:14px;border-radius:8px;font-weight:700;cursor:pointer;font-size:1rem;">👑 Upgrade to Pro — $14/mo</button>'
      + '<button onclick="document.getElementById(\'pk-upgrade-modal\').remove(); if(typeof showPage===\'function\') showPage(\'pricing\');" style="background:transparent;color:#00cc66;border:2px solid #00cc66;padding:12px;border-radius:8px;font-weight:700;cursor:pointer;font-size:0.95rem;">👑👑 Lifetime Royalty — $499</button>'
      + '</div>'
      + '<button onclick="document.getElementById(\'pk-upgrade-modal\').remove();" style="background:transparent;color:#555;border:none;cursor:pointer;font-size:0.85rem;">Maybe later</button>';

    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  // ── Update account page with current tier ───────────────────────────────────
  function updateAccountPage(tier) {
    var tierBadge = document.querySelector('#page-account h2');
    var tierDesc = document.querySelector('#page-account p');
    var upgradeBtn = document.querySelector('#page-account button[onclick*="pricing"]');

    if (!tierBadge) return;

    var tierInfo = {
      free: { icon: '🏆', name: 'Free Tier Member', desc: 'You have access to the daily Soccer 3-Leg Parlay', color: '#d4af37', showUpgrade: true },
      vip: { icon: '👑', name: 'VIP Elite Member', desc: 'Full access: Soccer, NBA, MLS, and Power Pick', color: '#d4af37', showUpgrade: false },
      pro: { icon: '👑', name: 'Pro Streamz 4K Member', desc: 'Full access: Soccer, NBA, MLS, and Power Pick', color: '#d4af37', showUpgrade: false },
      lifetime: { icon: '👑👑', name: 'Lifetime Royalty Member', desc: 'Unlimited lifetime access to all picks and features', color: '#00cc66', showUpgrade: false }
    };

    var info = tierInfo[tier] || tierInfo.free;
    var iconEl = tierBadge.previousElementSibling;
    if (iconEl) iconEl.textContent = info.icon;
    tierBadge.textContent = info.name;
    tierBadge.style.color = info.color;
    if (tierDesc) tierDesc.textContent = info.desc;

    // Show/hide upgrade button
    if (upgradeBtn) {
      upgradeBtn.style.display = info.showUpgrade ? 'inline-block' : 'none';
      if (!info.showUpgrade) {
        // Add manage subscription button instead
        var manageBtn = document.getElementById('pk-manage-sub-btn');
        if (!manageBtn) {
          manageBtn = document.createElement('button');
          manageBtn.id = 'pk-manage-sub-btn';
          manageBtn.style.cssText = 'padding:12px 28px;background:rgba(212,175,55,0.15);border:1px solid #d4af37;color:#d4af37;border-radius:8px;font-weight:700;cursor:pointer;font-size:1rem;';
          manageBtn.innerHTML = '⚙️ Manage Subscription';
          manageBtn.onclick = function() {
            if (confirm('Cancel subscription and return to Free tier?')) {
              localStorage.setItem('userTier', 'free');
              localStorage.removeItem('subscription_active');
              localStorage.removeItem('subscription_plan');
              localStorage.removeItem('subscription_expiry');
              localStorage.removeItem('currentUser');
              location.reload();
            }
          };
          upgradeBtn.parentNode.insertBefore(manageBtn, upgradeBtn.nextSibling);
        }
      }
    }

    // Add tier badge to account page header
    var tierBadgeEl = document.getElementById('pk-tier-badge-display');
    if (!tierBadgeEl) {
      tierBadgeEl = document.createElement('div');
      tierBadgeEl.id = 'pk-tier-badge-display';
      tierBadgeEl.style.cssText = 'display:inline-block;padding:4px 16px;border-radius:20px;font-size:0.8rem;font-weight:700;margin-bottom:16px;';
      var container = document.querySelector('#page-account .container');
      if (container) container.insertBefore(tierBadgeEl, container.firstChild);
    }
    tierBadgeEl.style.background = tier === 'lifetime' ? 'rgba(0,204,102,0.2)' : 'rgba(212,175,55,0.2)';
    tierBadgeEl.style.color = tier === 'lifetime' ? '#00cc66' : '#d4af37';
    tierBadgeEl.style.border = '1px solid ' + (tier === 'lifetime' ? '#00cc66' : '#d4af37');
    tierBadgeEl.textContent = tier.toUpperCase() + ' TIER';
  }

  // ── Update pricing page buttons based on current tier ───────────────────────
  function updatePricingPage(tier) {
    // Replace "Join Pro" and "Get Lifetime Access" buttons with PayPal forms
    var pricingSection = document.getElementById('page-pricing');
    if (!pricingSection) return;
    if (pricingSection.dataset.paypalLoaded) return; // Already done

    // Find and replace Pro button
    var buttons = pricingSection.querySelectorAll('button');
    buttons.forEach(function(btn) {
      if (btn.textContent.trim() === 'Join Pro') {
        var formHtml = '<form action="https://www.paypal.com/cgi-bin/webscr" method="post" target="_blank" style="width:100%;margin-top:16px;" onsubmit="localStorage.setItem(\'selected_plan\',\'vip-monthly\')">'
          + '<input type="hidden" name="cmd" value="_xclick-subscriptions">'
          + '<input type="hidden" name="business" value="Glenoring@gmail.com">'
          + '<input type="hidden" name="item_name" value="VIP Membership - Soccer Parlay King">'
          + '<input type="hidden" name="item_number" value="vip-monthly">'
          + '<input type="hidden" name="a3" value="14.00">'
          + '<input type="hidden" name="p3" value="1">'
          + '<input type="hidden" name="t3" value="M">'
          + '<input type="hidden" name="src" value="1">'
          + '<input type="hidden" name="sra" value="1">'
          + '<input type="hidden" name="no_note" value="1">'
          + '<input type="hidden" name="rm" value="2">'
          + '<input type="hidden" name="return" value="https://soccernbaparlayking.vip/?payment=success&plan=vip-monthly">'
          + '<input type="hidden" name="cancel_return" value="https://soccernbaparlayking.vip/?payment=cancelled">'
          + '<input type="hidden" name="notify_url" value="https://soccernbaparlayking.vip/api/payment/ipn">'
          + '<input type="hidden" name="currency_code" value="USD">'
          + '<input type="hidden" name="lc" value="US">'
          + '<input type="hidden" name="bn" value="PP-SubscriptionsBF">'
          + '<button type="submit" style="width:100%;padding:12px;background:#d4af37;border:none;color:#0f1419;border-radius:8px;font-weight:700;cursor:pointer;font-size:1rem;">💳 Subscribe with PayPal — $14/mo</button>'
          + '</form>';
        var wrapper = document.createElement('div');
        wrapper.innerHTML = formHtml;
        btn.parentNode.replaceChild(wrapper.firstChild, btn);
      }

      if (btn.textContent.trim() === 'Get Lifetime Access') {
        var lifetimeFormHtml = '<form action="https://www.paypal.com/cgi-bin/webscr" method="post" target="_blank" style="width:100%;margin-top:16px;" onsubmit="localStorage.setItem(\'selected_plan\',\'lifetime\')">'
          + '<input type="hidden" name="cmd" value="_xclick">'
          + '<input type="hidden" name="business" value="Glenoring@gmail.com">'
          + '<input type="hidden" name="item_name" value="Lifetime Royalty - Soccer Parlay King">'
          + '<input type="hidden" name="item_number" value="lifetime-royalty">'
          + '<input type="hidden" name="amount" value="499.00">'
          + '<input type="hidden" name="no_note" value="1">'
          + '<input type="hidden" name="rm" value="2">'
          + '<input type="hidden" name="return" value="https://soccernbaparlayking.vip/?payment=success&plan=lifetime">'
          + '<input type="hidden" name="cancel_return" value="https://soccernbaparlayking.vip/?payment=cancelled">'
          + '<input type="hidden" name="notify_url" value="https://soccernbaparlayking.vip/api/payment/ipn">'
          + '<input type="hidden" name="currency_code" value="USD">'
          + '<input type="hidden" name="lc" value="US">'
          + '<input type="hidden" name="bn" value="PP-BuyNowBF">'
          + '<button type="submit" style="width:100%;padding:12px;background:#00cc66;border:none;color:#0f1419;border-radius:8px;font-weight:700;cursor:pointer;font-size:1rem;">💳 Pay with PayPal — $499 Once</button>'
          + '</form>';
        var lifetimeWrapper = document.createElement('div');
        lifetimeWrapper.innerHTML = lifetimeFormHtml;
        btn.parentNode.replaceChild(lifetimeWrapper.firstChild, btn);
      }
    });

    // Mark as loaded
    pricingSection.dataset.paypalLoaded = 'true';

    // If already pro, show "Current Plan" on the right card
    if (isProUser()) {
      var forms = pricingSection.querySelectorAll('form');
      forms.forEach(function(f) {
        var planInput = f.querySelector('[name="item_number"]');
        if (planInput) {
          var plan = planInput.value;
          var currentTier = getCurrentTier();
          if ((currentTier === 'vip' && plan === 'vip-monthly') ||
              (currentTier === 'lifetime' && plan === 'lifetime-royalty')) {
            var submitBtn = f.querySelector('button[type="submit"]');
            if (submitBtn) {
              submitBtn.textContent = '✓ Current Plan';
              submitBtn.disabled = true;
              submitBtn.style.background = 'rgba(212,175,55,0.2)';
              submitBtn.style.color = '#d4af37';
              submitBtn.style.border = '1px solid #d4af37';
            }
          }
        }
      });
    }
  }

  // ── Check URL for payment success/cancel on page load ───────────────────────
  function checkPaymentReturn() {
    var params = new URLSearchParams(window.location.search);
    var payment = params.get('payment');
    var plan = params.get('plan') || localStorage.getItem('selected_plan') || 'vip-monthly';

    if (payment === 'success') {
      // Clean URL
      window.history.replaceState({}, document.title, window.location.pathname);
      handlePaymentSuccess(plan);
    } else if (payment === 'cancelled') {
      window.history.replaceState({}, document.title, window.location.pathname);
      var cancelMsg = document.createElement('div');
      cancelMsg.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1a1f2e;border:1px solid #d4af37;color:#ccc;padding:12px 24px;border-radius:8px;z-index:9999;font-size:0.9rem;';
      cancelMsg.textContent = 'Payment cancelled. You can upgrade anytime from the Pricing page.';
      document.body.appendChild(cancelMsg);
      setTimeout(function() { cancelMsg.remove(); }, 5000);
    }
  }

  // ── Expose globals ───────────────────────────────────────────────────────────
  window.pkGetTier = getCurrentTier;
  window.pkIsProUser = isProUser;
  window.pkShowUpgradePrompt = showUpgradePrompt;

  // ── Initialize on DOM ready ──────────────────────────────────────────────────
  function init() {
    checkPaymentReturn();
    applyTierGating();

    // Re-apply gating when pricing/account pages are shown
    var origShowPage = window.showPage;
    if (typeof origShowPage === 'function') {
      window.showPage = function(page) {
        origShowPage(page);
        if (page === 'pricing') {
          setTimeout(function() { updatePricingPage(getCurrentTier()); }, 50);
        }
        if (page === 'account') {
          setTimeout(function() { updateAccountPage(getCurrentTier()); }, 50);
        }
      };
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
