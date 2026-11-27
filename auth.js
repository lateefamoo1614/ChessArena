
// ========================================
// CHESSARENA AUTHENTICATION
// ========================================

async function registerUser(username, email, password) {
  const response = await fetch("/api/auth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    credentials: "same-origin",
    body: JSON.stringify({ username, email, password })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || "Registration failed.");
  }

  return data;
}

async function loginUser(email, password) {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    credentials: "same-origin",
    body: JSON.stringify({ email, password })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || "Login failed.");
  }

  return data;
}

async function getCurrentUser() {
  try {
    const response = await fetch("/api/auth/me", {
      credentials: "same-origin"
    });

    if (!response.ok) return null;

    const data = await response.json();

    return data.authenticated ? data.user : null;

  } catch (error) {
    console.error("Could not check login:", error);
    return null;
  }
}

async function logoutUser() {
  const response = await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "same-origin"
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || "Logout failed.");
  }

  return data;
}

// ========================================
// HOMEPAGE LOGIN DISPLAY
// ========================================

async function updateNavigation() {
  const loginButton = document.getElementById("login-btn");
  const signupButton = document.getElementById("signup-btn");

  if (!loginButton || !signupButton) return;

  const user = await getCurrentUser();

  if (user) {
    const navButtons = document.querySelector(".nav-buttons");

    navButtons.innerHTML = `
      <span style="color:#00C8FF;font-weight:bold;">
        ● ${user.username}
      </span>

      <span style="color:#00C875;font-size:12px;">
        Online
      </span>

      <button id="logout-btn" type="button">
        Log Out
      </button>
    `;

    document.getElementById("logout-btn").addEventListener("click", async () => {
      try {
        await logoutUser();
        window.location.reload();
      } catch (error) {
        alert(error.message);
      }
    });

  } else {
    loginButton.onclick = () => {
      window.location.href = "login.html";
    };

    signupButton.onclick = () => {
      window.location.href = "signup.html";
    };
  }
}

document.addEventListener("DOMContentLoaded", updateNavigation);
