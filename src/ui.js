import { sunTimes } from './sun.js'
import { seasonParams } from './seasons.js'

const YEAR = new Date().getFullYear()

const fmtTime = new Intl.DateTimeFormat('sv-SE', {
  hour: '2-digit', minute: '2-digit',
})
const fmtDate = new Intl.DateTimeFormat('sv-SE', {
  day: 'numeric', month: 'long',
})

export function dayOfYearToDate(doy, minutes) {
  const d = new Date(YEAR, 0, 1)
  d.setDate(doy)
  d.setMinutes(minutes)
  return d
}

/**
 * Kopplar reglagen och panelen. `onChange(date)` anropas vid varje ändring,
 * `getWindows(date)` ska returnera dagens solfönster (cache:as per dag).
 */
export function setupUI({ lat, lon, onChange, getWindows }) {
  const el = {
    date: document.getElementById('date-slider'),
    time: document.getElementById('time-slider'),
    dateLabel: document.getElementById('date-label'),
    seasonIcon: document.getElementById('season-icon'),
    timeLabel: document.getElementById('time-label'),
    status: document.getElementById('status'),
    windows: document.getElementById('windows'),
    suntimes: document.getElementById('suntimes'),
  }

  const now = new Date()
  const startOfYear = new Date(YEAR, 0, 1)
  el.date.value = Math.floor((now - startOfYear) / 86400000) + 1
  el.time.value = now.getHours() * 60 + Math.floor(now.getMinutes() / 5) * 5

  let windowsCacheKey = null
  let windowsCache = null

  function currentDate() {
    return dayOfYearToDate(Number(el.date.value), Number(el.time.value))
  }

  function update() {
    const date = currentDate()
    el.dateLabel.textContent = fmtDate.format(date)
    el.timeLabel.textContent = fmtTime.format(date)

    const times = sunTimes(date, lat, lon)
    el.suntimes.textContent = `Soluppgång ${fmtTime.format(times.sunrise)} · Solnedgång ${fmtTime.format(times.sunset)}`

    const key = el.date.value
    if (key !== windowsCacheKey) {
      windowsCacheKey = key
      el.seasonIcon.textContent = seasonParams(Number(key)).icon
      windowsCache = getWindows(date)
      el.windows.replaceChildren()
      if (windowsCache.length) {
        const total = windowsCache.reduce(
          (sum, w) => sum + (w.end - w.start) / 60000, 0
        )
        const h = Math.floor(total / 60)
        const m = Math.round(total % 60)
        el.windows.append(
          `Sol på uteplatsen ${h ? `${h} h ` : ''}${m ? `${m} min` : ''}: `
        )
        windowsCache.forEach((w, i) => {
          if (i > 0) el.windows.append(', ')
          const b = document.createElement('b')
          b.textContent = `${fmtTime.format(w.start)}–${fmtTime.format(w.end)}`
          el.windows.append(b)
        })
      } else {
        const b = document.createElement('b')
        b.textContent = 'Ingen sol på uteplatsen denna dag'
        el.windows.append(b)
      }
    }

    const sunlitNow = onChange(date, Number(el.date.value))
    if (sunlitNow === null) {
      el.status.textContent = '🌙 Solen är under horisonten'
      el.status.className = 'night'
    } else if (sunlitNow) {
      el.status.textContent = '☀️ Sol på uteplatsen'
      el.status.className = 'sun'
    } else {
      el.status.textContent = '🌑 Skugga på uteplatsen'
      el.status.className = 'shade'
    }
  }

  el.date.addEventListener('input', update)
  el.time.addEventListener('input', update)
  update()
}
