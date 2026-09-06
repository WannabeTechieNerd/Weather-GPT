/* ============================================================
   Atmos — Weather UI
   ------------------------------------------------------------
   Live weather: Open-Meteo (no API key needed).
   Chat assistant: Groq API (cloud), configured in
   Settings → AI Weather Assistant.
   ============================================================ */

// ---------------- Settings ----------------

const DEFAULT_SETTINGS = {
  tempUnit: "C",          // "C" | "F"
  windUnit: "kmh",        // "kmh" | "mph"
  timeFormat: "12",       // "12" | "24"
  autoRefresh: true,
  refreshInterval: 15,    // minutes
  notifications: false,
  mistralEnabled: false,
  mistralKey: "",
  mistralModel: "llama-3.1-8b-instant"
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("atmos-settings"));
    return { ...DEFAULT_SETTINGS, ...(saved || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function persistSettings() {
  localStorage.setItem("atmos-settings", JSON.stringify(settings));
}

let settings = loadSettings();
let refreshTimer = null;

// ---------------- Locations (dynamic — saved list persists in localStorage) ----------------

const DEFAULT_LOCATIONS = [
  { name: "Manali, Himachal Pradesh", lat: 32.2432, lon: 77.1892 },
  { name: "Delhi, India", lat: 28.6139, lon: 77.2090 },
  { name: "Mumbai, Maharashtra", lat: 19.0760, lon: 72.8777 },
  { name: "Bengaluru, Karnataka", lat: 12.9716, lon: 77.5946 }
];

function loadSavedLocations() {
  try {
    const saved = JSON.parse(localStorage.getItem("atmos-locations"));
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {}
  return [...DEFAULT_LOCATIONS];
}

function persistSavedLocations() {
  localStorage.setItem("atmos-locations", JSON.stringify(savedLocations));
}

let savedLocations = loadSavedLocations();
const locationCoords = {};
savedLocations.forEach(loc => { locationCoords[loc.name] = { lat: loc.lat, lon: loc.lon }; });

// Placeholder sample data shown before the first live fetch completes,
// and as a fallback if a fetch fails.
const FALLBACK_DATA = {
  tempC: 18, feelsC: 18, highC: 22, lowC: 12, condition: "Loading…",
  windKmh: 0, windDir: "--", humidity: 0, precip: 0,
  uv: 0, uvLabel: "--", sunrise: "--:--", sunset: "--:--"
};

const locations = {};
savedLocations.forEach(loc => { locations[loc.name] = { ...FALLBACK_DATA }; });

let hourlyData = [];
let weeklyData = [];
let currentLocation = savedLocations[0].name;

// ---------------- WMO weather code mapping ----------------
// https://open-meteo.com/en/docs — "weather_code" field

function mapWeatherCode(code) {
  if (code === 0) return { condition: "Clear Sky", type: "sun" };
  if (code === 1 || code === 2) return { condition: "Partly Cloudy", type: "partly" };
  if (code === 3) return { condition: "Overcast", type: "cloud" };
  if (code === 45 || code === 48) return { condition: "Foggy", type: "cloud" };
  if ([51, 53, 55, 56, 57].includes(code)) return { condition: "Drizzle", type: "rain" };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { condition: "Rain", type: "rain" };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { condition: "Snow", type: "snow" };
  if ([95, 96, 99].includes(code)) return { condition: "Thunderstorm", type: "storm" };
  return { condition: "Unknown", type: "partly" };
}

const icon = type => ({ sun: "☀", partly: "🌤", cloud: "☁", rain: "☁︎", snow: "❄", storm: "⚡" }[type] || "☀");

function degToCompass(deg) {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

// ---------------- Open-Meteo fetch ----------------

async function fetchLiveWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m` +
    `&hourly=temperature_2m,weather_code` +
    `&daily=temperature_2m_max,temperature_2m_min,uv_index_max,sunrise,sunset,weather_code` +
    `&timezone=auto&forecast_days=7`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo request failed (${res.status})`);
  const data = await res.json();

  const current = data.current;
  const daily = data.daily;
  const { condition } = mapWeatherCode(current.weather_code);

  const weatherState = {
    tempC: Math.round(current.temperature_2m),
    feelsC: Math.round(current.apparent_temperature),
    highC: Math.round(daily.temperature_2m_max[0]),
    lowC: Math.round(daily.temperature_2m_min[0]),
    condition,
    windKmh: Math.round(current.wind_speed_10m),
    windDir: degToCompass(current.wind_direction_10m),
    humidity: Math.round(current.relative_humidity_2m),
    precip: current.precipitation > 0 ? Math.min(100, Math.round(current.precipitation * 20)) : 0,
    uv: Math.round(daily.uv_index_max[0]),
    uvLabel: uvLabel(daily.uv_index_max[0]),
    sunrise: daily.sunrise[0].slice(11, 16),
    sunset: daily.sunset[0].slice(11, 16)
  };

  // Next 7 hours from "now" for the hourly strip
  const nowHour = new Date().getHours();
  const startIdx = data.hourly.time.findIndex(t => new Date(t).getHours() === nowHour) || 0;
  const hourly = data.hourly.time.slice(startIdx, startIdx + 7).map((t, i) => {
    const idx = startIdx + i;
    const label = i === 0 ? "Now" : new Date(data.hourly.time[idx]).toLocaleTimeString("en-IN", { hour: "numeric", hour12: true });
    const { type } = mapWeatherCode(data.hourly.weather_code[idx]);
    return [label, type, Math.round(data.hourly.temperature_2m[idx])];
  });

  const weekly = daily.time.map((dateStr, i) => {
    const day = new Date(dateStr).toLocaleDateString("en-IN", { weekday: "short" }).toUpperCase();
    const { type } = mapWeatherCode(daily.weather_code[i]);
    return [day, type, Math.round(daily.temperature_2m_max[i]), Math.round(daily.temperature_2m_min[i])];
  });

  return { weatherState, hourly, weekly };
}

function uvLabel(uv) {
  if (uv >= 8) return "Very High";
  if (uv >= 6) return "High";
  if (uv >= 3) return "Moderate";
  return "Low";
}

async function loadLocation(name) {
  const { lat, lon } = locationCoords[name];
  try {
    const { weatherState, hourly, weekly } = await fetchLiveWeather(lat, lon);
    locations[name] = weatherState;
    if (name === currentLocation) {
      hourlyData = hourly;
      weeklyData = weekly;
      renderAll();
    }
  } catch (err) {
    console.error(err);
    showToast("Couldn't reach Open-Meteo — showing last known data");
  }
}

// ---------------- Unit helpers ----------------

const cToF = c => Math.round(c * 9 / 5 + 32);
const kmhToMph = k => Math.round(k * 0.621371);

function formatTemp(celsius) {
  return settings.tempUnit === "F" ? cToF(celsius) : celsius;
}

function formatWind(kmh) {
  return settings.windUnit === "mph" ? `${kmhToMph(kmh)} mph` : `${kmh} km/h`;
}

function formatClock(hhmm) {
  if (hhmm === "--:--") return hhmm;
  const [h, m] = hhmm.split(":").map(Number);
  if (settings.timeFormat === "24") {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(hour12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${period}`;
}

// ---------------- Rendering ----------------

function renderCurrentWeather() {
  const data = locations[currentLocation];
  document.getElementById("temperature").textContent = formatTemp(data.tempC);
  document.getElementById("tempUnitLabel").textContent = settings.tempUnit;
  document.getElementById("feelsLike").textContent = `${formatTemp(data.feelsC)}°`;
  document.getElementById("condition").textContent = data.condition;
  document.getElementById("high").textContent = `${formatTemp(data.highC)}°`;
  document.getElementById("low").textContent = `${formatTemp(data.lowC)}°`;

  document.getElementById("windSpeed").textContent = formatWind(data.windKmh);
  document.getElementById("windDir").textContent = data.windDir;
  document.getElementById("humidity").textContent = `${data.humidity}%`;
  document.getElementById("precip").textContent = `${data.precip}%`;
  document.getElementById("uvIndex").textContent = data.uv;
  document.getElementById("uvLabel").textContent = data.uvLabel;

  document.getElementById("sunriseTime").textContent = formatClock(data.sunrise);
  document.getElementById("sunsetTime").textContent = formatClock(data.sunset);

  document.getElementById("locationName").textContent = currentLocation;
  document.getElementById("chatLocationName").textContent = currentLocation;
}

function renderHourly() {
  document.getElementById("hourly").innerHTML = hourlyData.map(([time, type, tempC]) => `
    <div class="forecast-item">
      <div class="forecast-time">${time}</div>
      <div class="mini-icon mini-${type}">${icon(type)}</div>
      <div class="forecast-temp">${formatTemp(tempC)}°</div>
    </div>
  `).join("");
}

function renderWeekly() {
  document.getElementById("weekly").innerHTML = weeklyData.map(([day, type, highC, lowC]) => `
    <div class="forecast-item">
      <div class="day">${day}</div>
      <div class="mini-icon mini-${type}">${icon(type)}</div>
      <div class="forecast-temp">${formatTemp(highC)}°</div>
      <span class="low-temp">${formatTemp(lowC)}°</span>
    </div>
  `).join("");
}

function renderAll() {
  renderCurrentWeather();
  renderHourly();
  renderWeekly();
}

function updateClock() {
  const now = new Date();
  document.getElementById("dateText").textContent = now.toLocaleDateString("en-IN", {
    weekday: "long", day: "numeric", month: "long"
  });
  document.getElementById("timeText").textContent = settings.timeFormat === "24"
    ? now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false })
    : now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("show"), 2400);
}

// ---------------- Location picker ----------------

const locationPickerBtn = document.getElementById("locationPicker");
const locationMenu = document.getElementById("locationMenu");
const savedLocationsList = document.getElementById("savedLocationsList");
const locationSearchInput = document.getElementById("locationSearchInput");
const locationSearchResults = document.getElementById("locationSearchResults");
const useMyLocationBtn = document.getElementById("useMyLocationBtn");
const useMyLocationLabel = document.getElementById("useMyLocationLabel");

locationPickerBtn.addEventListener("click", () => {
  locationMenu.classList.toggle("open");
  locationPickerBtn.classList.toggle("open");
});

document.addEventListener("click", e => {
  if (!e.target.closest("#locationPicker") && !e.target.closest("#locationMenu")) {
    locationMenu.classList.remove("open");
    locationPickerBtn.classList.remove("open");
  }
});

function closeLocationMenu() {
  locationMenu.classList.remove("open");
  locationPickerBtn.classList.remove("open");
}

// Adds (or reuses) a location by name+coords, makes it current, saves it to
// the persisted list, and kicks off a live weather fetch for it.
function selectLocation(name, lat, lon) {
  locationCoords[name] = { lat, lon };
  if (!locations[name]) locations[name] = { ...FALLBACK_DATA };

  const existingIdx = savedLocations.findIndex(l => l.name === name);
  if (existingIdx !== -1) savedLocations.splice(existingIdx, 1);
  savedLocations.unshift({ name, lat, lon });
  if (savedLocations.length > 8) savedLocations = savedLocations.slice(0, 8);
  persistSavedLocations();

  currentLocation = name;
  renderSavedLocationsList();
  renderCurrentWeather();
  closeLocationMenu();
  locationSearchInput.value = "";
  locationSearchResults.innerHTML = "";
  showToast(`Fetching live weather for ${name}…`);
  loadLocation(name);
}

function removeSavedLocation(name, e) {
  e.stopPropagation();
  if (savedLocations.length <= 1) {
    showToast("Keep at least one saved location");
    return;
  }
  savedLocations = savedLocations.filter(l => l.name !== name);
  persistSavedLocations();
  if (currentLocation === name) {
    selectLocation(savedLocations[0].name, savedLocations[0].lat, savedLocations[0].lon);
  } else {
    renderSavedLocationsList();
  }
}

function renderSavedLocationsList() {
  savedLocationsList.innerHTML = savedLocations.map(loc => `
    <div class="location-saved-item">
      <button class="location-select-btn" data-name="${escapeHtml(loc.name)}">
        <span class="${loc.name === currentLocation ? "location-current" : ""}">${escapeHtml(loc.name)}</span>
      </button>
      <button class="location-remove-btn" data-name="${escapeHtml(loc.name)}" aria-label="Remove ${escapeHtml(loc.name)}">✕</button>
    </div>
  `).join("");

  savedLocationsList.querySelectorAll(".location-select-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const loc = savedLocations.find(l => l.name === btn.dataset.name);
      if (loc) selectLocation(loc.name, loc.lat, loc.lon);
    });
  });

  savedLocationsList.querySelectorAll(".location-remove-btn").forEach(btn => {
    btn.addEventListener("click", e => removeSavedLocation(btn.dataset.name, e));
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

renderSavedLocationsList();

// ---------------- Location search (OpenStreetMap Nominatim geocoder) ----------------
// Nominatim is free and has no API key, and — unlike many lightweight geocoders —
// its data comes from OpenStreetMap, which tends to have far better coverage of
// small villages/hamlets than city-focused geocoders. Usage policy: max ~1
// request/second and no heavy automated use — fine for a personal/community app,
// but if this app grows into something with real traffic, self-host Nominatim or
// switch to a paid geocoder (LocationIQ, OpenCage, Mapbox) with a proper key.

let searchDebounceTimer = null;
let searchAbortController = null;

function describeResultType(item) {
  const t = (item.type || item.class || "").replace(/_/g, " ");
  return t || "place";
}

function buildResultLabel(item) {
  const addr = item.address || {};
  const primary = addr.village || addr.hamlet || addr.town || addr.city || addr.suburb ||
    item.name || item.display_name.split(",")[0];
  const region = addr.state_district || addr.county || addr.state || "";
  const country = addr.country || "";
  return [primary, region, country].filter(Boolean).join(", ");
}

async function searchLocations(query) {
  if (searchAbortController) searchAbortController.abort();
  searchAbortController = new AbortController();

  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}` +
    `&format=jsonv2&addressdetails=1&limit=8`;

  const res = await fetch(url, { signal: searchAbortController.signal });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  return res.json();
}

function renderSearchStatus(message) {
  locationSearchResults.innerHTML = `<div class="location-search-status">${escapeHtml(message)}</div>`;
}

function renderSearchResults(results) {
  if (!results.length) {
    renderSearchStatus("No matches — try a nearby town or district name.");
    return;
  }
  locationSearchResults.innerHTML = results.map((item, i) => `
    <button class="location-result-btn" data-idx="${i}">
      <span class="location-result-name">${escapeHtml(buildResultLabel(item))}</span>
      <span class="location-result-meta">${escapeHtml(describeResultType(item))}</span>
    </button>
  `).join("");

  locationSearchResults.querySelectorAll(".location-result-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const item = results[Number(btn.dataset.idx)];
      selectLocation(buildResultLabel(item), Number(item.lat), Number(item.lon));
    });
  });
}

locationSearchInput.addEventListener("input", () => {
  const query = locationSearchInput.value.trim();
  clearTimeout(searchDebounceTimer);

  if (query.length < 3) {
    locationSearchResults.innerHTML = "";
    return;
  }

  renderSearchStatus("Searching…");
  searchDebounceTimer = setTimeout(async () => {
    try {
      const results = await searchLocations(query);
      renderSearchResults(results);
    } catch (err) {
      if (err.name === "AbortError") return;
      console.error(err);
      renderSearchStatus("Couldn't search right now — check your connection.");
    }
  }, 500);
});

// ---------------- Geolocation ("Use my current location") ----------------

async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2&addressdetails=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Reverse geocode failed (${res.status})`);
  return res.json();
}

useMyLocationBtn.addEventListener("click", () => {
  if (!("geolocation" in navigator)) {
    showToast("Geolocation isn't supported in this browser");
    return;
  }

  useMyLocationBtn.disabled = true;
  useMyLocationLabel.textContent = "Locating…";

  navigator.geolocation.getCurrentPosition(
    async pos => {
      const { latitude: lat, longitude: lon } = pos.coords;
      let name = `My Location (${lat.toFixed(3)}, ${lon.toFixed(3)})`;
      try {
        const place = await reverseGeocode(lat, lon);
        if (place && place.display_name) name = buildResultLabel(place);
      } catch (err) {
        console.error(err);
        // Fall back to coordinate-based name — weather fetch itself doesn't need the name.
      }
      useMyLocationBtn.disabled = false;
      useMyLocationLabel.textContent = "Use my current location";
      selectLocation(name, lat, lon);
    },
    err => {
      useMyLocationBtn.disabled = false;
      useMyLocationLabel.textContent = "Use my current location";
      const messages = {
        1: "Location access denied — enable it in your browser settings to use this.",
        2: "Couldn't determine your location — try again outdoors or with GPS on.",
        3: "Location request timed out — try again."
      };
      showToast(messages[err.code] || "Couldn't get your location.");
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
  );
});

// ---------------- Side menu (hamburger) ----------------

const menuBtn = document.getElementById("menuBtn");
const sideMenu = document.getElementById("sideMenu");
const closeMenuBtn = document.getElementById("closeMenuBtn");
const scrim = document.getElementById("scrim");
const settingsPanel = document.getElementById("settingsPanel");

function openSideMenu() {
  sideMenu.classList.add("open");
  scrim.classList.add("show");
  menuBtn.setAttribute("aria-expanded", "true");
}

function closeSideMenu() {
  sideMenu.classList.remove("open");
  menuBtn.setAttribute("aria-expanded", "false");
  if (!settingsPanel.classList.contains("open")) scrim.classList.remove("show");
}

menuBtn.addEventListener("click", openSideMenu);
closeMenuBtn.addEventListener("click", closeSideMenu);

document.querySelectorAll(".side-menu-item[data-target]").forEach(item => {
  item.addEventListener("click", () => {
    document.querySelectorAll(".side-menu-item[data-target]").forEach(i => i.classList.remove("active"));
    item.classList.add("active");
    const target = document.querySelector(item.dataset.target);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    closeSideMenu();
  });
});

document.getElementById("menuAboutBtn").addEventListener("click", () => {
  closeSideMenu();
  showToast("Atmos — live weather via Open-Meteo, chat via Groq.");
});

// ---------------- Settings panel ----------------

const settingsBtn = document.getElementById("settingsBtn");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const menuSettingsBtn = document.getElementById("menuSettingsBtn");

function openSettings() {
  settingsPanel.classList.add("open");
  scrim.classList.add("show");
  applySettingsToForm();
}

function closeSettings() {
  settingsPanel.classList.remove("open");
  if (!sideMenu.classList.contains("open")) scrim.classList.remove("show");
}

settingsBtn.addEventListener("click", openSettings);
closeSettingsBtn.addEventListener("click", closeSettings);
menuSettingsBtn.addEventListener("click", () => {
  closeSideMenu();
  openSettings();
});

scrim.addEventListener("click", () => {
  closeSideMenu();
  closeSettings();
});

// Segmented toggles (temp unit / wind unit / time format)
function wireSegmented(id, onChange) {
  const group = document.getElementById(id);
  group.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      group.querySelectorAll("button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      group.dataset.value = btn.dataset.value;
      onChange(btn.dataset.value);
    });
  });
}

wireSegmented("unitTempToggle", value => { settings.tempUnit = value; });
wireSegmented("unitWindToggle", value => { settings.windUnit = value; });
wireSegmented("unitTimeToggle", value => { settings.timeFormat = value; });

// Switches
function wireSwitch(id, onChange) {
  const el = document.getElementById(id);
  el.addEventListener("click", () => {
    const next = el.getAttribute("aria-checked") !== "true";
    el.setAttribute("aria-checked", String(next));
    onChange(next);
  });
}

wireSwitch("autoRefreshToggle", checked => {
  settings.autoRefresh = checked;
  document.getElementById("refreshIntervalRow").classList.toggle("disabled", !checked);
});

wireSwitch("notifToggle", checked => { settings.notifications = checked; });

wireSwitch("assistantToggle", checked => {
  settings.mistralEnabled = checked;
  updateMistralStatus();
});

document.getElementById("refreshInterval").addEventListener("change", e => {
  settings.refreshInterval = Number(e.target.value);
});

const mistralKeyInput = document.getElementById("mistralKeyInput");
const mistralModelSelect = document.getElementById("mistralModel");

mistralKeyInput.addEventListener("input", () => {
  settings.mistralKey = mistralKeyInput.value.trim();
  updateMistralStatus();
});

mistralModelSelect.addEventListener("change", () => {
  settings.mistralModel = mistralModelSelect.value;
  updateMistralStatus();
});

document.getElementById("testMistralBtn").addEventListener("click", async () => {
  const status = document.getElementById("mistralStatus");
  if (!settings.mistralKey) {
    status.textContent = "Add a key above first.";
    status.classList.remove("connected");
    return;
  }
  status.textContent = "Testing…";
  status.classList.remove("connected");
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${settings.mistralKey}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status.textContent = `Key works — ready to use ${mistralModelSelect.options[mistralModelSelect.selectedIndex].text}.`;
    status.classList.add("connected");
  } catch (err) {
    status.textContent = "Key test failed — check it's correct and has quota.";
    status.classList.remove("connected");
  }
});

function updateMistralStatus() {
  const status = document.getElementById("mistralStatus");
  if (!settings.mistralEnabled) {
    status.textContent = "Assistant disabled.";
    status.classList.remove("connected");
  } else if (!settings.mistralKey) {
    status.textContent = "Add a key above to enable the assistant.";
    status.classList.remove("connected");
  } else {
    status.textContent = `Ready — using ${mistralModelSelect.options[mistralModelSelect.selectedIndex].text}. Use "Test API key" to verify.`;
    status.classList.remove("connected");
  }
}

function applySettingsToForm() {
  document.querySelectorAll("#unitTempToggle button").forEach(b => b.classList.toggle("active", b.dataset.value === settings.tempUnit));
  document.querySelectorAll("#unitWindToggle button").forEach(b => b.classList.toggle("active", b.dataset.value === settings.windUnit));
  document.querySelectorAll("#unitTimeToggle button").forEach(b => b.classList.toggle("active", b.dataset.value === settings.timeFormat));

  document.getElementById("autoRefreshToggle").setAttribute("aria-checked", String(settings.autoRefresh));
  document.getElementById("refreshIntervalRow").classList.toggle("disabled", !settings.autoRefresh);
  document.getElementById("refreshInterval").value = String(settings.refreshInterval);
  document.getElementById("notifToggle").setAttribute("aria-checked", String(settings.notifications));

  document.getElementById("assistantToggle").setAttribute("aria-checked", String(settings.mistralEnabled));
  mistralKeyInput.value = settings.mistralKey;
  mistralModelSelect.value = settings.mistralModel;
  updateMistralStatus();
}

document.getElementById("saveSettingsBtn").addEventListener("click", () => {
  persistSettings();
  renderAll();
  updateClock();
  setupAutoRefresh();
  closeSettings();
  showToast("Settings saved");
});

document.getElementById("resetSettingsBtn").addEventListener("click", () => {
  settings = { ...DEFAULT_SETTINGS };
  persistSettings();
  applySettingsToForm();
  renderAll();
  updateClock();
  setupAutoRefresh();
  showToast("Settings reset to defaults");
});

// ---------------- Auto-refresh ----------------

function setupAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  if (!settings.autoRefresh) return;
  refreshTimer = setInterval(() => {
    loadLocation(currentLocation);
  }, settings.refreshInterval * 60 * 1000);
}

// ---------------- Groq chat assistant (uses mistral* var/id names internally) ----------------

const chatFab = document.getElementById("chatFab");
const chatPanel = document.getElementById("chatPanel");
const closeChatBtn = document.getElementById("closeChatBtn");
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");

chatFab.addEventListener("click", () => chatPanel.classList.toggle("open"));
closeChatBtn.addEventListener("click", () => chatPanel.classList.remove("open"));

function appendChatBubble(text, cls) {
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${cls}`;
  bubble.textContent = text;
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return bubble;
}

chatForm.addEventListener("submit", async e => {
  e.preventDefault();
  const question = chatInput.value.trim();
  if (!question) return;
  chatInput.value = "";
  appendChatBubble(question, "user");

  if (!settings.mistralEnabled || !settings.mistralKey) {
    appendChatBubble("Add and enable a Groq API key in Settings → AI Weather Assistant to use chat.", "error");
    return;
  }

  const loadingBubble = appendChatBubble("Thinking…", "loading");
  try {
    const answer = await askMistral(question);
    loadingBubble.remove();
    appendChatBubble(answer, "assistant");
  } catch (err) {
    console.error(err);
    loadingBubble.remove();
    appendChatBubble(`Couldn't reach Groq — ${err.message || "check your API key and try again."}`, "error");
  }
});

/**
 * Sends `question` to the Groq API along with the current live
 * conditions for `currentLocation`, so answers are grounded in
 * real data rather than guesses.
 *
 * IMPORTANT: this calls api.groq.com directly from the browser
 * using the key saved in Settings. That's fine for local/personal
 * use, but if you deploy this site publicly, anyone can open dev
 * tools, read the key out of localStorage or the network tab, and
 * spend your quota. For a public deployment, put this call behind
 * a small backend/serverless proxy that holds the key server-side
 * instead — the browser calls your proxy, your proxy calls Groq.
 */
async function askMistral(question) {
  const data = locations[currentLocation];
  const contextSummary =
    `Location: ${currentLocation}. ` +
    `Condition: ${data.condition}. Temperature: ${formatTemp(data.tempC)}°${settings.tempUnit} ` +
    `(feels like ${formatTemp(data.feelsC)}°${settings.tempUnit}). ` +
    `High/Low: ${formatTemp(data.highC)}°/${formatTemp(data.lowC)}°. ` +
    `Wind: ${formatWind(data.windKmh)} ${data.windDir}. Humidity: ${data.humidity}%. ` +
    `Precipitation chance: ${data.precip}%. UV index: ${data.uv} (${data.uvLabel}). ` +
    `Sunrise: ${formatClock(data.sunrise)}, Sunset: ${formatClock(data.sunset)}.`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.mistralKey}`
    },
    body: JSON.stringify({
      model: settings.mistralModel || "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content: "You are a friendly weather assistant inside a weather app. Use only the live " +
            "conditions the user gives you to answer — don't invent numbers. Keep answers short " +
            "(2-4 sentences), conversational, and practical."
        },
        { role: "user", content: `Current conditions:\n${contextSummary}\n\nQuestion: ${question}` }
      ],
      temperature: 0.6,
      max_tokens: 220
    })
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    if (res.status === 429) throw new Error("Rate limit exceeded — wait a moment or check your Groq plan limits.");
    throw new Error(errBody?.error?.message || `Groq request failed (${res.status})`);
  }

  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  return (text || "").trim() || "I couldn't come up with an answer for that.";
}

// ---------------- Init ----------------

applySettingsToForm();
renderAll();
updateClock();
setInterval(updateClock, 1000);
setupAutoRefresh();
loadLocation(currentLocation);
