// One artifact, full page: its meta.json, a slim header (back to the gallery,
// title, tags, the version picker, the commit it came from) and the page
// itself below. `?v=2` opens an earlier version; the latest opens otherwise.
;(function () {
  'use strict'

  function byId(id) {
    return document.getElementById(id)
  }

  // meta.json is a file in a repository, which anyone with push access can
  // edit by hand: a page is only ever one of this artifact's own versions,
  // and a commit link only ever a web address.
  function isVersionPage(entry) {
    return typeof entry === 'string' && /^v[0-9]+\/[^:\\]*$/.test(entry) && entry.split('/').indexOf('..') === -1
  }

  function webAddress(url) {
    try {
      var parsed = new URL(url, location.href)
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null
    } catch {
      return null
    }
  }

  function shortDate(iso) {
    var date = new Date(iso)
    return isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''
  }

  function missing(text) {
    byId('title').textContent = 'Not found'
    byId('frame').hidden = true
    var note = byId('missing')
    note.hidden = false
    note.textContent = text
  }

  function show(meta, wanted) {
    var versions = (meta.versions || []).filter(function (entry) {
      return entry && typeof entry.version === 'number' && isVersionPage(entry.entry)
    })
    versions.sort(function (a, b) {
      return b.version - a.version
    })
    if (!versions.length) return missing('This artifact has no published version.')
    var current =
      versions.filter(function (entry) {
        return entry.version === wanted
      })[0] || versions[0]

    document.title = meta.title + (current.version !== versions[0].version ? ' (v' + current.version + ')' : '') + ' · Artifacts'
    byId('title').textContent = meta.title
    byId('title').title = meta.description || meta.title

    var tags = byId('tags')
    tags.textContent = ''
    ;(meta.tags || []).forEach(function (tag) {
      var chip = document.createElement('span')
      chip.className = 'chip'
      chip.textContent = tag
      tags.appendChild(chip)
    })

    var picker = byId('version')
    picker.textContent = ''
    versions.forEach(function (entry) {
      var option = document.createElement('option')
      option.value = String(entry.version)
      option.textContent = 'v' + entry.version + ' · ' + shortDate(entry.publishedAt) + (entry === versions[0] ? ' (latest)' : '')
      picker.appendChild(option)
    })
    picker.value = String(current.version)
    picker.hidden = versions.length < 2

    var source = current.source || meta.source || {}
    var commit = byId('commit')
    if (source.commit) {
      commit.hidden = false
      commit.textContent = source.commit.slice(0, 7)
      commit.title = [source.repo, source.branch, source.commit].filter(Boolean).join(' · ')
      var link = source.commitUrl ? webAddress(source.commitUrl) : null
      if (link) commit.href = link
      else commit.removeAttribute('href')
    } else {
      commit.hidden = true
    }

    var page = current.entry
    byId('alone').href = page
    byId('alone').hidden = false
    var frame = byId('frame')
    frame.hidden = false
    frame.title = meta.title
    if (frame.getAttribute('src') !== page) frame.setAttribute('src', page)
  }

  function start() {
    var params = new URLSearchParams(location.search)
    var wanted = Number(params.get('v')) || null
    fetch('meta.json', { cache: 'no-cache' })
      .then(function (response) {
        if (!response.ok) throw new Error(response.status === 404 ? 'This artifact is not published here.' : 'meta.json answered ' + response.status)
        return response.json()
      })
      .then(function (meta) {
        show(meta, wanted)
        byId('version').addEventListener('change', function (event) {
          var version = Number(event.target.value)
          var latest = Math.max.apply(
            null,
            meta.versions.map(function (entry) {
              return entry.version
            }),
          )
          history.replaceState(null, '', location.pathname + (version === latest ? '' : '?v=' + version))
          show(meta, version)
        })
      })
      .catch(function (error) {
        missing(error.message)
      })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()
