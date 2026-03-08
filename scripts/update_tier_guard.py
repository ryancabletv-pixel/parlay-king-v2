#!/usr/bin/env python3
with open('/home/ubuntu/parlay-king/server/templates/tier-guard.js', 'r') as f:
    content = f.read()

# Find the showPaymentSuccessModal function boundaries
start_marker = '  // \u2500\u2500 Show payment success modal \u2500'
end_marker = '\n  // \u2500\u2500 Apply tier gating'

idx_start = content.find(start_marker)
idx_end = content.find(end_marker)

if idx_start < 0 or idx_end < 0:
    print(f"ERROR: start={idx_start}, end={idx_end}")
    exit(1)

print(f"Replacing lines {idx_start}-{idx_end}")

new_section = '''  // -- Show payment success -- redirects to registration form
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

'''

content = content[:idx_start] + new_section + content[idx_end:]
with open('/home/ubuntu/parlay-king/server/templates/tier-guard.js', 'w') as f:
    f.write(content)
print("SUCCESS: tier-guard.js payment modal updated to redirect to registration")
