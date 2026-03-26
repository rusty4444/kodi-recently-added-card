/**
 * Kodi Recently Added Card
 * Custom Lovelace card that displays the latest movies and TV shows
 * from Kodi's JSON-RPC API, with interleaved movie/show cycling and
 * cinematic transitions. Adapted from Plex Recently Added Card.
 */

class KodiRecentlyAddedCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._items = [];
    this._currentIndex = 0;
    this._cycleTimer = null;
    this._config = {};
    this._trailerCache = {}; // keyed by tmdbId (or imdbId), value: URL string or ''
  }

  setConfig(config) {
    if (!config.kodi_url) throw new Error('Please define kodi_url');

    this._config = {
      kodi_url: config.kodi_url.replace(/\/$/, ''),
      kodi_username: config.kodi_username || null,
      kodi_password: config.kodi_password || null,
      movies_count: config.movies_count || 5,
      shows_count: config.shows_count || 5,
      cycle_interval: config.cycle_interval || 8,
      title: config.title !== undefined ? config.title : 'Recently Added',
      ...config,
    };

    this._render();
    this._fetchData();
  }

  set hass(hass) {
    this._hass = hass;
  }

  /**
   * Build headers for Kodi JSON-RPC requests.
   * Includes basic auth if username/password are configured.
   */
  _getHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (this._config.kodi_username && this._config.kodi_password) {
      const credentials = btoa(
        `${this._config.kodi_username}:${this._config.kodi_password}`
      );
      headers['Authorization'] = `Basic ${credentials}`;
    }
    return headers;
  }

  /**
   * Send a JSON-RPC request to Kodi.
   */
  async _kodiRPC(method, params = {}) {
    const url = `${this._config.kodi_url}/jsonrpc`;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: 1,
    });
    const resp = await fetch(url, {
      method: 'POST',
      headers: this._getHeaders(),
      body,
    });
    if (!resp.ok) throw new Error(`Kodi HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.error) throw new Error(`Kodi RPC error: ${data.error.message}`);
    return data.result;
  }

  /**
   * Convert a Kodi art value to a usable image URL via Kodi's image proxy.
   * Art values look like: image://http%3a%2f%2f... or image:///local/path
   * Served at: {kodi_url}/image/{encodeURIComponent(artValue)}
   */
  _getImageUrl(artValue) {
    if (!artValue) return '';
    const base = this._config.kodi_url;
    return `${base}/image/${encodeURIComponent(artValue)}`;
  }

  /**
   * Fetch a YouTube trailer URL from TMDB for the given ID.
   * Accepts either a TMDB numeric ID or an IMDB ID (starting with 'tt').
   * Results are cached in this._trailerCache.
   * Returns a YouTube URL string, or '' if none found / API not configured.
   */
  async _fetchTrailer(id) {
    if (!this._config.tmdb_api_key) return '';
    if (!id) return '';

    // Check cache
    if (id in this._trailerCache) return this._trailerCache[id];

    const bearer = this._config.tmdb_api_key;
    const headers = { Authorization: `Bearer ${bearer}` };

    try {
      let numericId = id;

      // If it's an IMDB ID (starts with 'tt'), resolve to TMDB ID first
      if (String(id).startsWith('tt')) {
        const findUrl = `https://api.themoviedb.org/3/find/${id}?external_source=imdb_id`;
        const findResp = await fetch(findUrl, { headers });
        if (!findResp.ok) throw new Error(`TMDB find HTTP ${findResp.status}`);
        const findData = await findResp.json();
        const movieResults = (findData.movie_results || []);
        if (!movieResults.length) {
          this._trailerCache[id] = '';
          return '';
        }
        numericId = movieResults[0].id;
      }

      // Fetch trailer videos
      const videosUrl = `https://api.themoviedb.org/3/movie/${numericId}/videos?language=en-US`;
      const videosResp = await fetch(videosUrl, { headers });
      if (!videosResp.ok) throw new Error(`TMDB videos HTTP ${videosResp.status}`);
      const videosData = await videosResp.json();
      const videos = videosData.results || [];

      // Pick best YouTube trailer:
      // 1. Official YouTube Trailer, 2. Any YouTube Trailer, 3. Any YouTube video
      const ytVideos = videos.filter(v => v.site === 'YouTube');
      const officialTrailer = ytVideos.find(v => v.type === 'Trailer' && v.official);
      const anyTrailer = ytVideos.find(v => v.type === 'Trailer');
      const anyYt = ytVideos[0];
      const best = officialTrailer || anyTrailer || anyYt || null;

      const result = best ? `https://www.youtube.com/watch?v=${best.key}` : '';
      // Cache under both the original id and the resolved numeric id
      this._trailerCache[id] = result;
      if (numericId !== id) this._trailerCache[numericId] = result;
      return result;
    } catch (err) {
      console.warn('Kodi Recently Added Card: TMDB trailer fetch error', err);
      this._trailerCache[id] = '';
      return '';
    }
  }

  async _fetchData() {
    try {
      const moviesCount = this._config.movies_count;
      const showsCount = this._config.shows_count;

      // Fetch recently added movies
      const moviesResult = await this._kodiRPC('VideoLibrary.GetRecentlyAddedMovies', {
        properties: ['title', 'year', 'rating', 'runtime', 'genre', 'plot', 'art', 'dateadded', 'mpaa', 'imdbnumber'],
        limits: { start: 0, end: moviesCount },
      });

      // Fetch recently added episodes (fetch more for deduplication)
      const episodesResult = await this._kodiRPC('VideoLibrary.GetRecentlyAddedEpisodes', {
        properties: ['title', 'showtitle', 'season', 'episode', 'rating', 'runtime', 'plot', 'art', 'dateadded', 'tvshowid'],
        limits: { start: 0, end: showsCount * 4 },
      });

      const rawMovies = moviesResult.movies || [];
      const rawEpisodes = episodesResult.episodes || [];

      // Parse Kodi dateadded string "YYYY-MM-DD HH:MM:SS" to Unix timestamp
      const parseDate = (str) => {
        if (!str) return 0;
        // Replace space with T for ISO 8601 compatibility
        return Math.floor(new Date(str.replace(' ', 'T')).getTime() / 1000);
      };

      // Map movies to display items
      const movieItems = rawMovies.map((movie) => {
        const genres = (movie.genre || []).join(', ');
        const subtitleParts = [
          movie.year ? String(movie.year) : null,
          movie.mpaa || null,
          genres || null,
        ].filter(Boolean);

        return {
          title: movie.title || '',
          subtitle: subtitleParts.join(' · '),
          type: 'movie',
          typeLabel: 'Movie',
          rating: movie.rating ? parseFloat(movie.rating.toFixed(1)) : null,
          duration: movie.runtime ? Math.round(movie.runtime / 60) : null,
          summary: movie.plot || '',
          thumb: movie.art && movie.art.poster ? movie.art.poster : '',
          art: movie.art && movie.art.fanart ? movie.art.fanart : '',
          addedAt: parseDate(movie.dateadded),
          tmdbId: movie.imdbnumber || '',
          trailerUrl: null, // null = not yet fetched; '' = fetched, none found
        };
      });

      // Sort movies by addedAt descending (Kodi already returns most recent
      // first, but sort anyway for safety) then trim
      movieItems.sort((a, b) => b.addedAt - a.addedAt);
      const finalMovies = movieItems.slice(0, moviesCount);

      // Sort episodes by addedAt descending
      const sortedEpisodes = rawEpisodes
        .slice()
        .sort((a, b) => parseDate(b.dateadded) - parseDate(a.dateadded));

      // Deduplicate TV episodes — only keep the most recent per show
      const seenShows = new Set();
      const uniqueEpisodes = [];
      for (const ep of sortedEpisodes) {
        const showName = ep.showtitle || ep.title || '';
        if (!seenShows.has(showName)) {
          seenShows.add(showName);
          uniqueEpisodes.push(ep);
        }
        if (uniqueEpisodes.length >= showsCount) break;
      }

      // Map episodes to display items
      const tvItems = uniqueEpisodes.map((ep) => {
        const season = String(ep.season || 0).padStart(2, '0');
        const epNum = String(ep.episode || 0).padStart(2, '0');
        return {
          title: ep.showtitle || ep.title || '',
          subtitle: `S${season}E${epNum} · ${ep.title || ''}`,
          type: 'tv',
          typeLabel: 'TV Show',
          rating: ep.rating ? parseFloat(ep.rating.toFixed(1)) : null,
          duration: ep.runtime ? Math.round(ep.runtime / 60) : null,
          summary: ep.plot || '',
          thumb: (ep.art && (ep.art['tvshow.poster'] || ep.art.thumb)) || '',
          art: (ep.art && (ep.art['tvshow.fanart'] || ep.art.fanart)) || '',
          addedAt: parseDate(ep.dateadded),
          tvshowId: ep.tvshowid || null,
          seasonNumber: ep.season || null,
          trailerUrl: null,
        };
      });

      // Interleave: movie, show, movie, show, …
      const interleaved = [];
      const maxLen = Math.max(finalMovies.length, tvItems.length);
      for (let i = 0; i < maxLen; i++) {
        if (i < finalMovies.length) interleaved.push(finalMovies[i]);
        if (i < tvItems.length) interleaved.push(tvItems[i]);
      }

      this._items = interleaved;
      this._currentIndex = 0;
      this._updateDisplay();
      this._startCycle();
    } catch (err) {
      console.warn('Kodi Recently Added Card: Fetch error', err);
      const errEl = this.shadowRoot.querySelector('.error-msg');
      if (errEl) {
        errEl.textContent = `Could not connect to Kodi: ${err.message}`;
        errEl.style.display = 'block';
      }
    }
  }

  _startCycle() {
    if (this._cycleTimer) clearInterval(this._cycleTimer);
    if (this._items.length <= 1) return;

    this._cycleTimer = setInterval(() => {
      this._currentIndex = (this._currentIndex + 1) % this._items.length;
      this._updateDisplay();
    }, this._config.cycle_interval * 1000);
  }

  _updateDisplay() {
    if (!this._items.length) return;
    const item = this._items[this._currentIndex];
    const root = this.shadowRoot;

    // Background art — crossfade transition
    const bgEl = root.querySelector('.bg-art');
    const bgNew = root.querySelector('.bg-art-next');
    if (bgNew && item.art) {
      const artUrl = this._getImageUrl(item.art);
      bgNew.style.backgroundImage = `url(${artUrl})`;
      bgNew.classList.add('active');
      setTimeout(() => {
        if (bgEl) bgEl.style.backgroundImage = bgNew.style.backgroundImage;
        bgNew.classList.remove('active');
      }, 800);
    }

    // Poster — fade in on load
    const posterEl = root.querySelector('.poster');
    if (posterEl && item.thumb) {
      posterEl.style.opacity = '0';
      const img = new Image();
      img.onload = () => {
        posterEl.src = img.src;
        posterEl.style.opacity = '1';
      };
      img.src = this._getImageUrl(item.thumb);
    }

    // Text elements
    const titleEl = root.querySelector('.item-title');
    const subtitleEl = root.querySelector('.item-subtitle');
    const typeEl = root.querySelector('.item-type');
    const ratingEl = root.querySelector('.item-rating');
    const summaryEl = root.querySelector('.item-summary');
    const dotsEl = root.querySelector('.dots');
    const counterEl = root.querySelector('.counter');

    if (titleEl) titleEl.textContent = item.title;
    if (subtitleEl) subtitleEl.textContent = item.subtitle;
    if (typeEl) {
      typeEl.textContent = item.typeLabel;
      typeEl.className = `item-type ${item.type}`;
    }
    if (ratingEl) {
      if (item.rating) {
        // Kodi uses 0–10 scale; display with one decimal
        ratingEl.textContent = `★ ${item.rating.toFixed(1)}`;
        ratingEl.style.display = 'inline-block';
      } else {
        ratingEl.style.display = 'none';
      }
    }
    if (summaryEl) summaryEl.textContent = item.summary;

    // Trailer button — show for movies and TV shows; lazy-fetch trailer URL
    const trailerBtn = root.querySelector('.trailer-btn');
    if (trailerBtn) {
      trailerBtn.classList.remove('visible');
      trailerBtn.onclick = null;

      const showTrailerBtn = (url) => {
        if (url && this._items[this._currentIndex] === item) {
          trailerBtn.classList.add('visible');
          trailerBtn.onclick = (e) => { e.stopPropagation(); this._playTrailer(url); };
        }
      };

      if (item.trailerUrl) {
        showTrailerBtn(item.trailerUrl);
      } else if (item.trailerUrl === null) {
        // Not yet fetched — determine fetch method
        let fetchPromise;
        if (item.type === 'movie' && item.tmdbId) {
          fetchPromise = this._fetchTrailer(item.tmdbId);
        } else if (item.type === 'tv' && item.tvshowId) {
          fetchPromise = this._fetchTvTrailer(item.tvshowId, item.seasonNumber);
        }
        if (fetchPromise) {
          fetchPromise.then((url) => {
            item.trailerUrl = url || undefined;
            showTrailerBtn(url);
          });
        }
      }
    }

    // Dots — color-coded: gold for movies, blue for TV
    if (dotsEl) {
      dotsEl.innerHTML = this._items
        .map((it, i) => {
          const colorClass = it.type === 'movie' ? 'movie' : 'tv';
          const activeClass = i === this._currentIndex ? 'active' : '';
          return `<span class="dot ${colorClass} ${activeClass}"></span>`;
        })
        .join('');
    }

    // Counter
    if (counterEl) {
      counterEl.textContent = `${this._currentIndex + 1} / ${this._items.length}`;
    }

    // Time ago
    const timeEl = root.querySelector('.time-ago');
    if (timeEl && item.addedAt) {
      const now = Date.now() / 1000;
      const diff = now - item.addedAt;
      let timeStr;
      if (diff < 3600) timeStr = `${Math.round(diff / 60)}m ago`;
      else if (diff < 86400) timeStr = `${Math.round(diff / 3600)}h ago`;
      else timeStr = `${Math.round(diff / 86400)}d ago`;
      timeEl.textContent = timeStr;
    }
  }

  async _fetchTvTrailer(tvshowId, seasonNumber) {
    const cacheKey = `tv_${tvshowId}_${seasonNumber}`;
    if (cacheKey in this._trailerCache) return this._trailerCache[cacheKey];
    if (!this._config.tmdb_api_key) return null;

    const bearer = this._config.tmdb_api_key;
    const headers = { Authorization: `Bearer ${bearer}`, Accept: 'application/json' };

    try {
      // Step 1: Get the TV show details from Kodi to find its imdbnumber (TMDB ID)
      const showResult = await this._kodiRPC('VideoLibrary.GetTVShowDetails', {
        tvshowid: tvshowId,
        properties: ['imdbnumber'],
      });
      const imdbnumber = showResult?.tvshowdetails?.imdbnumber || '';
      if (!imdbnumber) {
        this._trailerCache[cacheKey] = null;
        return null;
      }

      // Resolve to a numeric TMDB ID (imdbnumber may be TMDB numeric or IMDB 'tt...')
      let tmdbId = imdbnumber;
      if (String(imdbnumber).startsWith('tt')) {
        // It's an IMDB ID — find the TMDB TV show ID
        const findResp = await fetch(
          `https://api.themoviedb.org/3/find/${imdbnumber}?external_source=imdb_id`,
          { headers }
        );
        if (findResp.ok) {
          const findData = await findResp.json();
          const tvResult = (findData.tv_results || [])[0];
          if (tvResult) tmdbId = String(tvResult.id);
          else { this._trailerCache[cacheKey] = null; return null; }
        } else { this._trailerCache[cacheKey] = null; return null; }
      }

      // Step 2: Try season-specific trailer first
      let youtubeUrl = null;
      if (seasonNumber) {
        try {
          const seasonResp = await fetch(
            `https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}/videos?language=en-US`,
            { headers }
          );
          if (seasonResp.ok) {
            const seasonData = await seasonResp.json();
            const vids = seasonData.results || [];
            const trailer = vids.find(v => v.type === 'Trailer' && v.site === 'YouTube' && v.official) ||
                            vids.find(v => v.type === 'Trailer' && v.site === 'YouTube') ||
                            vids.find(v => v.site === 'YouTube');
            if (trailer) youtubeUrl = `https://www.youtube.com/watch?v=${trailer.key}`;
          }
        } catch (e) { /* fall through to series-level */ }
      }

      // Step 3: Fall back to series-level trailer
      if (!youtubeUrl) {
        const seriesResp = await fetch(
          `https://api.themoviedb.org/3/tv/${tmdbId}/videos?language=en-US`,
          { headers }
        );
        if (seriesResp.ok) {
          const seriesData = await seriesResp.json();
          const vids = seriesData.results || [];
          const trailer = vids.find(v => v.type === 'Trailer' && v.site === 'YouTube' && v.official) ||
                          vids.find(v => v.type === 'Trailer' && v.site === 'YouTube') ||
                          vids.find(v => v.site === 'YouTube');
          if (trailer) youtubeUrl = `https://www.youtube.com/watch?v=${trailer.key}`;
        }
      }

      this._trailerCache[cacheKey] = youtubeUrl;
      return youtubeUrl;
    } catch (err) {
      console.warn('Kodi Recently Added Card: TV trailer fetch error', err);
      this._trailerCache[cacheKey] = null;
      return null;
    }
  }

  _getYouTubeId(url) {
    if (!url) return null;
    const match = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]{11})/) ||
                  url.match(/[?&]videoid=([\w-]{11})/);
    return match ? match[1] : null;
  }

  _playTrailer(url) {
    const ytId = this._getYouTubeId(url);
    if (!ytId) return;

    // Pause cycling
    if (this._cycleTimer) {
      clearInterval(this._cycleTimer);
      this._cycleTimer = null;
    }

    // Create fullscreen overlay on document.body
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.92);z-index:99999;display:flex;align-items:center;justify-content:center;cursor:pointer;';

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:relative;width:90vw;max-width:960px;aspect-ratio:16/9;background:#000;border-radius:8px;overflow:hidden;';

    const playerDiv = document.createElement('div');
    playerDiv.id = 'yt-trailer-player-' + Date.now();
    playerDiv.style.cssText = 'width:100%;height:100%;';
    wrapper.appendChild(playerDiv);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'position:absolute;top:8px;right:8px;width:36px;height:36px;border-radius:50%;background:rgba(0,0,0,0.7);border:1px solid rgba(255,255,255,0.3);color:#fff;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:100001;';
    wrapper.appendChild(closeBtn);

    overlay.appendChild(wrapper);
    document.body.appendChild(overlay);

    const self = this;
    const close = () => {
      if (self._ytPlayer) { try { self._ytPlayer.destroy(); } catch(e) {} self._ytPlayer = null; }
      overlay.remove();
      self._startCycle();
    };
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); close(); });
    overlay.addEventListener('click', close);
    wrapper.addEventListener('click', (e) => e.stopPropagation());

    // Load YouTube IFrame API and create player
    const initPlayer = () => {
      self._ytPlayer = new YT.Player(playerDiv.id, {
        width: '100%',
        height: '100%',
        videoId: ytId,
        playerVars: {
          autoplay: 1,
          controls: 1,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          enablejsapi: 1,
          origin: window.location.origin
        }
      });
    };

    if (window.YT && window.YT.Player) {
      initPlayer();
    } else {
      // Load the YouTube IFrame API script
      if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
        const tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag);
      }
      const check = setInterval(() => {
        if (window.YT && window.YT.Player) {
          clearInterval(check);
          initPlayer();
        }
      }, 100);
      setTimeout(() => clearInterval(check), 10000);
    }
  }

  _render() {
    const title = this._config.title;

    // Official Kodi logo
    const kodiLogoSvg = `<svg class="kodi-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-label="Kodi">
      <path fill="#17b2e8" d="M12.03.047c-.226 0-.452.107-.669.324-.922.922-1.842 1.845-2.763 2.768-.233.233-.455.48-.703.695-.31.267-.405.583-.399.988.02 1.399.008 2.799.008 4.198 0 1.453-.002 2.907 0 4.36 0 .11.002.223.03.327.087.337.303.393.546.15 1.31-1.31 2.618-2.622 3.928-3.933l4.449-4.453c.43-.431.43-.905 0-1.336L12.697.37c-.216-.217-.442-.324-.668-.324zm7.224 7.23c-.223 0-.445.104-.65.309L14.82 11.37c-.428.429-.427.895 0 1.322l3.76 3.766c.44.44.908.44 1.346.002 1.215-1.216 2.427-2.433 3.644-3.647.182-.18.353-.364.43-.615v-.33c-.077-.251-.246-.436-.428-.617-1.224-1.22-2.443-2.445-3.666-3.668-.205-.205-.429-.307-.652-.307zM4.18 7.611c-.086.014-.145.094-.207.157L.209 11.572c-.28.284-.278.677.004.96l2.043 2.046c.59.59 1.177 1.182 1.767 1.772.169.168.33.139.416-.084.044-.114.062-.242.063-.364.004-1.283.004-2.567.004-3.851h-.002V8.184c0-.085-.01-.169-.022-.252-.019-.135-.072-.258-.207-.309a.186.186 0 0 0-.095-.012zm7.908 6.838c-.224 0-.447.106-.656.315L7.66 18.537c-.433.434-.433.899.002 1.334 1.215 1.216 2.43 2.43 3.643 3.649.18.18.361.354.611.433h.33c.244-.069.423-.226.598-.402 1.222-1.23 2.45-2.453 3.676-3.68.43-.43.427-.905-.004-1.338l-3.772-3.773c-.208-.208-.432-.311-.656-.31z"/>
    </svg>`;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          height: 100%;
          --card-bg: #1a1a1a;
          --card-border: rgba(255,255,255,0.06);
          --text-primary: #f0f0f0;
          --text-secondary: #999;
          --text-dim: #666;
          --accent-gold: #c9a73b;
          --accent-movie: #c9a73b;
          --accent-tv: #17b2e8;
        }

        ha-card {
          height: 100%;
          box-sizing: border-box;
          position: relative;
          background: var(--card-bg) !important;
          border-radius: 12px;
          overflow: hidden;
          border: 1px solid var(--card-border) !important;
        }

        .card {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: var(--card-bg);
          overflow: hidden;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }

        /* Background art with blur */
        .bg-art, .bg-art-next {
          position: absolute;
          top: 0; left: 0; right: 0; bottom: 0;
          background-size: cover;
          background-position: center;
          filter: blur(20px) brightness(0.3);
          transform: scale(1.1);
          transition: opacity 0.8s ease;
        }
        .bg-art-next {
          opacity: 0;
        }
        .bg-art-next.active {
          opacity: 1;
        }

        /* Dark overlay */
        .bg-overlay {
          position: absolute;
          top: 0; left: 0; right: 0; bottom: 0;
          background: linear-gradient(
            135deg,
            rgba(0,0,0,0.7) 0%,
            rgba(0,0,0,0.4) 50%,
            rgba(0,0,0,0.7) 100%
          );
        }

        /* Content */
        .content {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 1;
          padding: 20px;
          display: flex;
          flex-direction: column;
        }

        /* Header */
        .header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 14px;
        }

        .header-title {
          flex: 1;
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 15px;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--text-secondary);
        }

        .kodi-logo {
          width: 22px;
          height: 22px;
          flex-shrink: 0;
          display: inline-block;
          vertical-align: middle;
          border-radius: 4px;
        }

        .counter {
          font-size: 13px;
          color: var(--text-dim);
          font-variant-numeric: tabular-nums;
        }

        /* Main area */
        .main {
          display: flex;
          gap: 20px;
          flex: 1;
          min-height: 0;
        }

        /* Poster */
        .poster-wrap {
          flex-shrink: 0;
          width: auto;
          aspect-ratio: 2/3;
          height: 100%;
          border-radius: 6px;
          overflow: hidden;
          box-shadow: 0 4px 20px rgba(0,0,0,0.5);
          background: #111;
          position: relative;
        }

        .poster {
          width: 100%;
          height: 100%;
          object-fit: cover;
          transition: opacity 0.5s ease;
        }

        .poster-shimmer {
          position: absolute;
          inset: 0;
          background: linear-gradient(
            90deg,
            transparent 0%,
            rgba(255,255,255,0.03) 50%,
            transparent 100%
          );
          animation: shimmer 2s infinite;
        }

        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }

        /* Info */
        .info {
          flex: 1;
          display: flex;
          flex-direction: column;
          justify-content: center;
          min-width: 0;
          gap: 8px;
        }

        .item-type {
          display: inline-block;
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          padding: 5px 12px;
          border-radius: 3px;
          width: fit-content;
        }

        .item-type.movie {
          background: rgba(201, 167, 59, 0.15);
          color: var(--accent-movie);
        }

        .item-type.tv {
          background: rgba(23, 178, 232, 0.15);
          color: var(--accent-tv);
        }

        .item-title {
          font-size: 28px;
          font-weight: 700;
          color: var(--text-primary);
          line-height: 1.2;
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }

        .item-subtitle {
          font-size: 17px;
          color: var(--text-secondary);
          line-height: 1.3;
        }

        .meta-row {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .item-rating {
          font-size: 16px;
          font-weight: 600;
          color: var(--accent-gold);
        }

        .time-ago {
          font-size: 15px;
          color: var(--text-dim);
        }

        .item-summary {
          font-size: 16px;
          color: var(--text-dim);
          line-height: 1.5;
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 6;
          -webkit-box-orient: vertical;
          margin-top: 2px;
        }

        /* Dots — color-coded */
        .dots {
          display: flex;
          justify-content: center;
          gap: 6px;
          padding-top: 16px;
          flex-shrink: 0;
        }

        .dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: rgba(255,255,255,0.15);
          transition: all 0.3s ease;
        }

        .dot.movie {
          background: rgba(201, 167, 59, 0.25);
        }

        .dot.tv {
          background: rgba(23, 178, 232, 0.25);
        }

        .dot.active.movie {
          background: var(--accent-movie);
          box-shadow: 0 0 6px rgba(201, 167, 59, 0.4);
          width: 18px;
          border-radius: 3px;
        }

        .dot.active.tv {
          background: var(--accent-tv);
          box-shadow: 0 0 6px rgba(23, 178, 232, 0.4);
          width: 18px;
          border-radius: 3px;
        }

        /* Error */
        .error-msg {
          display: none;
          text-align: center;
          padding: 20px;
          color: #cc4444;
          font-size: 12px;
        }

        /* Loading */
        .loading {
          text-align: center;
          padding: 40px 20px;
          color: var(--text-dim);
          font-size: 12px;
        }

        /* Trailer button */
        .trailer-btn {
          display: none;
          align-items: center;
          justify-content: center;
          gap: 6px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
          color: #ddd;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 13px;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          padding: 8px 16px;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s ease;
          min-width: 100px;
          min-height: 38px;
        }

        .trailer-btn:hover {
          background: rgba(255, 255, 255, 0.2);
          color: #fff;
        }

        .trailer-btn.visible {
          display: inline-flex;
        }

        .trailer-btn svg {
          width: 16px;
          height: 16px;
          fill: currentColor;
        }

        /* Trailer embed container */
        .trailer-container {
          display: none;
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 10;
          background: #000;
          align-items: center;
          justify-content: center;
        }

        .trailer-container.active {
          display: flex;
        }

        .trailer-container iframe {
          width: 100%;
          height: 100%;
          border: none;
        }

        .trailer-close {
          position: absolute;
          top: 8px;
          right: 8px;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background: rgba(0, 0, 0, 0.7);
          border: 1px solid rgba(255, 255, 255, 0.3);
          color: #fff;
          font-size: 18px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 11;
          transition: background 0.2s;
        }

        .trailer-close:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      </style>

      <ha-card>
        <div class="card">
          <div class="bg-art"></div>
          <div class="bg-art-next"></div>
          <div class="bg-overlay"></div>

          <div class="trailer-container" id="trailerContainer">
            <button class="trailer-close" id="trailerClose">✕</button>
            <iframe id="trailerFrame" allow="autoplay; encrypted-media" allowfullscreen></iframe>
          </div>

          <div class="content">
            ${title ? `
            <div class="header">
              <span class="header-title">
                ${kodiLogoSvg}
                ${title}
              </span>
              <button class="trailer-btn" id="trailerBtn">
                <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                Trailer
              </button>
              <span class="counter"></span>
            </div>
            ` : ''}

            <div class="error-msg"></div>

            <div class="main">
              <div class="poster-wrap">
                <img class="poster" src="" alt="">
                <div class="poster-shimmer"></div>
              </div>
              <div class="info">
                <span class="item-type"></span>
                <div class="item-title">Loading...</div>
                <div class="item-subtitle"></div>
                <div class="meta-row">
                  <span class="item-rating"></span>
                  <span class="time-ago"></span>
                </div>
                <div class="item-summary"></div>
              </div>
            </div>

            <div class="dots"></div>
          </div>
        </div>
      </ha-card>
    `;
  }

  getCardSize() {
    return 4;
  }

  static getStubConfig() {
    return {
      kodi_url: 'http://192.168.1.100:8080',
      kodi_username: 'kodi',
      kodi_password: 'password',
      movies_count: 5,
      shows_count: 5,
      cycle_interval: 8,
      title: 'Recently Added',
      tmdb_api_key: 'YOUR_TMDB_READ_ACCESS_TOKEN',
    };
  }

  static getConfigForm() {
    return {
      schema: [
        {
          name: 'kodi_url',
          required: true,
          selector: { text: {} },
        },
        {
          name: 'kodi_username',
          selector: { text: {} },
        },
        {
          name: 'kodi_password',
          selector: { text: { type: 'password' } },
        },
        {
          type: 'grid',
          name: '',
          schema: [
            {
              name: 'movies_count',
              selector: { number: { min: 1, max: 20, mode: 'box' } },
            },
            {
              name: 'shows_count',
              selector: { number: { min: 1, max: 20, mode: 'box' } },
            },
          ],
        },
        {
          type: 'grid',
          name: '',
          schema: [
            {
              name: 'cycle_interval',
              selector: { number: { min: 3, max: 60, mode: 'box', unit_of_measurement: 'seconds' } },
            },
            {
              name: 'title',
              selector: { text: {} },
            },
          ],
        },
        {
          name: 'tmdb_api_key',
          selector: { text: { type: 'password' } },
        },
      ],
      computeLabel: (schema) => {
        const labels = {
          kodi_url: 'Kodi URL',
          kodi_username: 'Kodi Username',
          kodi_password: 'Kodi Password',
          movies_count: 'Number of Movies',
          shows_count: 'Number of TV Shows',
          cycle_interval: 'Cycle Interval',
          title: 'Card Title',
          tmdb_api_key: 'TMDB API Key (for trailers)',
        };
        return labels[schema.name] || schema.name;
      },
      computeHelper: (schema) => {
        const helpers = {
          kodi_url: 'e.g. http://192.168.1.100:8080',
          kodi_username: 'Optional — only if HTTP auth is enabled',
          kodi_password: 'Optional — only if HTTP auth is enabled',
          tmdb_api_key: 'Optional — enables trailer button. Get a free key at themoviedb.org',
        };
        return helpers[schema.name] || undefined;
      },
    };
  }

  disconnectedCallback() {
    if (this._cycleTimer) {
      clearInterval(this._cycleTimer);
      this._cycleTimer = null;
    }
  }
}

customElements.define('kodi-recently-added-card', KodiRecentlyAddedCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'kodi-recently-added-card',
  name: 'Kodi Recently Added',
  description: 'Auto-cycling display of recently added Kodi media — movies and TV shows.',
});
