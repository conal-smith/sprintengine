// The gallery: every published artifact from artifacts.json, newest first,
// narrowed as you type, by tag and by project, as cards or as a list. The
// filters live in the address, so a filtered gallery can be shared.
;(function () {
  'use strict'

  var VIEW_KEY = 'artifacts.view'
  var state = { all: [], query: '', tags: [], project: '', view: 'grid' }
  var els = {}

  function fold(text) {
    return String(text || '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
  }

  function age(iso) {
    var then = Date.parse(iso)
    if (!isFinite(then)) return ''
    var seconds = Math.max(0, (Date.now() - then) / 1000)
    if (seconds < 60) return 'just now'
    var minutes = Math.round(seconds / 60)
    if (minutes < 60) return minutes + ' min ago'
    var hours = Math.round(minutes / 60)
    if (hours < 24) return hours + ' h ago'
    var days = Math.round(hours / 24)
    if (days < 7) return days === 1 ? 'yesterday' : days + ' days ago'
    var date = new Date(then)
    var sameYear = date.getFullYear() === new Date().getFullYear()
    return date.toLocaleDateString(undefined, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag)
    for (var key in attrs || {}) {
      if (attrs[key] === null || attrs[key] === undefined) continue
      if (key === 'text') node.textContent = attrs[key]
      else if (key === 'class') node.className = attrs[key]
      else node.setAttribute(key, attrs[key])
    }
    ;(children || []).forEach(function (child) {
      if (child) node.appendChild(child)
    })
    return node
  }

  function haystack(artifact) {
    return fold([artifact.title, artifact.description, artifact.project, artifact.slug, (artifact.tags || []).join(' '), artifact.source && artifact.source.branch].join(' '))
  }

  function matches(artifact) {
    if (state.project && artifact.project !== state.project) return false
    for (var i = 0; i < state.tags.length; i++) if ((artifact.tags || []).indexOf(state.tags[i]) === -1) return false
    var words = fold(state.query).split(/\s+/).filter(Boolean)
    if (!words.length) return true
    var text = artifact._haystack
    return words.every(function (word) {
      return text.indexOf(word) !== -1
    })
  }

  function card(artifact) {
    var thumb = el('div', { class: 'thumb' })
    if (typeof artifact.thumbnail === 'string' && /^thumbnail\.(?:png|jpg|webp)(?:\?v=[0-9]+)?$/.test(artifact.thumbnail)) {
      thumb.appendChild(el('img', { src: 'a/' + artifact.slug + '/' + artifact.thumbnail, alt: '', loading: 'lazy', decoding: 'async' }))
    } else {
      thumb.appendChild(el('span', { class: 'initial', 'aria-hidden': 'true', text: (artifact.title || '?').trim().charAt(0).toUpperCase() }))
    }
    if (artifact.version > 1) thumb.appendChild(el('span', { class: 'version-badge', text: 'v' + artifact.version }))
    var meta = el('div', { class: 'meta' }, [
      artifact.project ? el('span', { class: 'project', text: artifact.project }) : null,
      el('time', { datetime: artifact.updatedAt, title: new Date(artifact.updatedAt).toLocaleString(), text: age(artifact.updatedAt) }),
    ])
    var chips = el(
      'div',
      { class: 'chips' },
      (artifact.tags || []).map(function (tag) {
        return el('span', { class: 'chip', text: tag })
      }),
    )
    var title = el('h2', { class: 'card-title' }, [el('a', { class: 'open', href: 'a/' + artifact.slug + '/', text: artifact.title })])
    return el('li', null, [el('article', { class: 'card', title: artifact.description || null }, [thumb, el('div', { class: 'card-body' }, [title, meta, chips])])])
  }

  function renderTags() {
    var counts = {}
    state.all.forEach(function (artifact) {
      ;(artifact.tags || []).forEach(function (tag) {
        counts[tag] = (counts[tag] || 0) + 1
      })
    })
    var tags = Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a] || a.localeCompare(b)
    })
    els.tags.textContent = ''
    els.tags.hidden = tags.length === 0
    tags.forEach(function (tag) {
      var on = state.tags.indexOf(tag) !== -1
      var button = el('button', { type: 'button', class: 'tag-filter', 'aria-pressed': on ? 'true' : 'false', text: tag })
      button.addEventListener('click', function () {
        state.tags = on
          ? state.tags.filter(function (t) {
              return t !== tag
            })
          : state.tags.concat(tag)
        update()
      })
      els.tags.appendChild(button)
    })
  }

  function renderProjects() {
    var projects = {}
    state.all.forEach(function (artifact) {
      if (artifact.project) projects[artifact.project] = true
    })
    var names = Object.keys(projects).sort()
    els.project.textContent = ''
    els.project.appendChild(el('option', { value: '', text: 'All projects' }))
    names.forEach(function (name) {
      els.project.appendChild(el('option', { value: name, text: name }))
    })
    els.project.value = state.project
    els.project.hidden = names.length < 2 && !state.project
  }

  function renderResults() {
    var shown = state.all.filter(matches)
    els.results.className = 'results ' + state.view
    els.results.textContent = ''
    shown.forEach(function (artifact) {
      els.results.appendChild(card(artifact))
    })
    var total = state.all.length
    els.count.textContent = shown.length === total ? total + (total === 1 ? ' artifact' : ' artifacts') : shown.length + ' of ' + total
    els.empty.hidden = shown.length > 0
    if (!shown.length) {
      els.empty.textContent = ''
      els.empty.appendChild(el('strong', { text: total ? 'Nothing matches' : 'Nothing published yet' }))
      els.empty.appendChild(document.createTextNode(total ? 'Try fewer words, or clear a filter.' : 'Artifacts an agent publishes appear here, newest first.'))
    }
    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (button) {
      button.setAttribute('aria-pressed', button.getAttribute('data-view') === state.view ? 'true' : 'false')
    })
  }

  function writeAddress() {
    var params = new URLSearchParams()
    if (state.query) params.set('q', state.query)
    state.tags.forEach(function (tag) {
      params.append('tag', tag)
    })
    if (state.project) params.set('project', state.project)
    var search = params.toString()
    history.replaceState(null, '', location.pathname + (search ? '?' + search : ''))
  }

  function update() {
    renderTags()
    renderProjects()
    renderResults()
    writeAddress()
  }

  function readAddress() {
    var params = new URLSearchParams(location.search)
    state.query = params.get('q') || ''
    state.tags = params.getAll('tag')
    state.project = params.get('project') || ''
    try {
      state.view = localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'
    } catch {
      state.view = 'grid'
    }
  }

  function start() {
    els.search = document.getElementById('search')
    els.project = document.getElementById('project')
    els.tags = document.getElementById('tags')
    els.results = document.getElementById('results')
    els.empty = document.getElementById('empty')
    els.count = document.getElementById('count')
    readAddress()
    els.search.value = state.query
    els.search.addEventListener('input', function () {
      state.query = els.search.value
      renderResults()
      writeAddress()
    })
    els.project.addEventListener('change', function () {
      state.project = els.project.value
      update()
    })
    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (button) {
      button.addEventListener('click', function () {
        state.view = button.getAttribute('data-view')
        try {
          localStorage.setItem(VIEW_KEY, state.view)
        } catch {
          // A private window keeps the choice for this visit only.
        }
        renderResults()
      })
    })
    document.addEventListener('keydown', function (event) {
      if (event.key === '/' && document.activeElement !== els.search) {
        event.preventDefault()
        els.search.focus()
      }
    })
    fetch('artifacts.json', { cache: 'no-cache' })
      .then(function (response) {
        if (!response.ok) throw new Error('artifacts.json answered ' + response.status)
        return response.json()
      })
      .then(function (manifest) {
        // Only entries whose slug names a folder of the site: the manifest is
        // a file anyone with push access can edit.
        state.all = (manifest.artifacts || []).filter(function (artifact) {
          return artifact && typeof artifact.slug === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(artifact.slug) && typeof artifact.title === 'string'
        })
        state.all.sort(function (a, b) {
          return String(b.updatedAt).localeCompare(String(a.updatedAt))
        })
        state.all.forEach(function (artifact) {
          artifact._haystack = haystack(artifact)
        })
        update()
      })
      .catch(function (error) {
        els.empty.hidden = false
        els.empty.textContent = 'The list of artifacts could not be read (' + error.message + ').'
      })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()
