/* global PipefyApp, AnakinPipefy */
(function () {
  var A = window.AnakinPipefy;
  var KEY_NAME = 'anakin_api_key';
  var root = document.getElementById('root');
  var surface = document.body.getAttribute('data-surface');
  var p;

  /* Scraped pages are untrusted. Everything goes in through textContent, never innerHTML. */
  function el(tag, props, children) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (name) {
      if (name === 'class') node.className = props[name];
      else if (name === 'text') node.textContent = props[name];
      else if (name === 'onclick') node.addEventListener('click', props[name]);
      else if (name === 'onsubmit') node.addEventListener('submit', props[name]);
      else node.setAttribute(name, props[name]);
    });
    (children || []).forEach(function (child) {
      node.appendChild(child);
    });
    return node;
  }

  function show(nodes) {
    root.textContent = '';
    nodes.forEach(function (node) {
      root.appendChild(node);
    });
  }

  function setStatus(node, kind, text) {
    node.className = 'status' + (kind ? ' ' + kind : '');
    node.textContent = text;
    node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  }

  function fetchFn(url, options) {
    return window.fetch(url, options);
  }

  function showFatal(message) {
    show([el('p', { class: 'status error', role: 'alert', text: message })]);
  }

  /* ---- Connect view ---- */

  function connectView(currentKey, card) {
    var input = el('input', {
      id: 'api-key',
      type: 'password',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'ask_…',
    });
    var status = el('p', { class: 'status' });
    var save = el('button', { type: 'submit', text: 'Connect' });

    function onSubmit(event) {
      event.preventDefault();
      var key = input.value.trim();
      if (!A.looksLikeApiKey(key)) {
        setStatus(status, 'error', 'That does not look like an Anakin API key. Keys start with ask_.');
        return;
      }
      save.disabled = true;
      setStatus(status, '', 'Checking your key…');
      A.verifyKey(fetchFn, key)
        .then(function () {
          return p.set('organization', 'private', KEY_NAME, key);
        })
        .then(function () {
          // Pipefy's docs: p.set's resolved value is unreliable, so read the key back to confirm the write.
          return p.get('organization', 'private', KEY_NAME);
        })
        .then(function (stored) {
          if (stored !== key) throw new Error('Key was not stored');
          p.showNotification('Anakin connected', 'success');
          scrapeView(key, card);
        })
        .catch(function (error) {
          save.disabled = false;
          var message =
            error instanceof A.ApiError || error instanceof TypeError
              ? A.friendlyError(error)
              : 'Could not save your key in Pipefy. Try again.';
          setStatus(status, 'error', message);
        });
    }

    var actions = el('div', { class: 'row' }, [save]);
    if (currentKey) {
      actions.appendChild(
        el('button', {
          type: 'button',
          class: 'secondary',
          text: 'Cancel',
          onclick: function () {
            scrapeView(currentKey, card);
          },
        })
      );
      actions.appendChild(
        el('button', {
          type: 'button',
          class: 'secondary',
          text: 'Remove key',
          onclick: function () {
            p.set('organization', 'private', KEY_NAME, '')
              .then(function () {
                p.showNotification('Anakin key removed', 'success');
                connectView('', card);
              })
              .catch(function () {
                setStatus(status, 'error', 'Could not remove your key. Try again.');
              });
          },
        })
      );
    }

    var help = el('p', { class: 'muted' });
    help.appendChild(document.createTextNode('Paste your Anakin API key. Get one, with a free tier, from the '));
    help.appendChild(el('a', { href: 'https://anakin.io/dashboard', target: '_blank', rel: 'noopener', text: 'Anakin dashboard' }));
    help.appendChild(document.createTextNode('. It is stored in Pipefy with private visibility, so only you can use it.'));

    show([
      el('h2', { text: 'Connect Anakin' }),
      help,
      el('form', { onsubmit: onSubmit }, [
        el('label', { for: 'api-key', text: 'API key' }),
        input,
        actions,
        status,
      ]),
    ]);
    input.focus();
  }

  /* ---- Scrape view ---- */

  function copyText(text) {
    var area = el('textarea', { 'aria-hidden': 'true', style: 'position:fixed;opacity:0' });
    area.value = text;
    document.body.appendChild(area);
    area.select();
    var copied = false;
    try {
      copied = document.execCommand('copy');
    } catch (e) {
      copied = false;
    }
    document.body.removeChild(area);
    return copied;
  }

  function saveToField(card, fieldId, value) {
    var mutation =
      'mutation SaveScrape($cardId: ID!, $fieldId: ID!, $value: [UndefinedInput]) {' +
      ' updateCardField(input: { card_id: $cardId, field_id: $fieldId, new_value: $value }) { success } }';
    return p.mutation(mutation, { cardId: card.id, fieldId: fieldId, value: value }).then(function (result) {
      if (result.errors) throw new Error(A.graphqlErrorMessage(result.errors));
      if (!result.data || !result.data.updateCardField || !result.data.updateCardField.success) {
        throw new Error('Pipefy did not confirm the save.');
      }
    });
  }

  function resultNodes(url, markdown, card) {
    return p.fields().then(function (fields) {
      var targets = A.longTextFields(fields);
      var saveStatus = el('p', { class: 'status' });
      var nodes = [
        el('p', {
          class: 'status ok',
          role: 'status',
          text: 'Scraped ' + markdown.length.toLocaleString('en-US') + ' characters from ' + url,
        }),
        el('pre', { id: 'preview', tabindex: '0', text: markdown }),
      ];
      var copy = el('button', {
        type: 'button',
        class: 'secondary',
        text: 'Copy Markdown',
        onclick: function () {
          if (copyText(markdown)) setStatus(saveStatus, 'ok', 'Copied.');
          else setStatus(saveStatus, 'error', 'Your browser blocked copying. Select the text above instead.');
        },
      });

      if (!targets.length) {
        nodes.push(
          el('p', {
            class: 'status',
            text: fields
              ? 'This pipe has no Long text field to save to. Add one, reopen this card, and scrape again.'
              : 'Could not load this pipe\'s fields, so saving is unavailable. Reopen the card to try again.',
          })
        );
        nodes.push(el('div', { class: 'row' }, [copy]));
        nodes.push(saveStatus);
        return nodes;
      }

      var select = el(
        'select',
        { id: 'target-field' },
        targets.map(function (field) {
          return el('option', { value: field.id, text: field.label || field.id });
        })
      );
      var saveButton = el('button', {
        type: 'button',
        text: 'Save to field',
        onclick: function () {
          saveButton.disabled = true;
          setStatus(saveStatus, '', 'Saving…');
          saveToField(card, select.value, A.formatForCard(url, markdown, new Date()))
            .then(function () {
              setStatus(saveStatus, 'ok', 'Saved to the card.');
              p.showNotification('Saved to the card', 'success');
            })
            .catch(function (error) {
              setStatus(saveStatus, 'error', 'Pipefy could not save this: ' + error.message);
            })
            .then(function () {
              saveButton.disabled = false;
            });
        },
      });

      nodes.push(
        el('div', { class: 'row' }, [
          el('div', { class: 'grow' }, [
            el('label', { for: 'target-field', text: 'Save to Long text field (replaces its current value)' }),
            select,
          ]),
          saveButton,
          copy,
        ])
      );
      nodes.push(saveStatus);
      return nodes;
    });
  }

  function scrapeView(apiKey, card) {
    var urlInput = el('input', {
      id: 'scrape-url',
      type: 'text',
      inputmode: 'url',
      placeholder: 'https://example.com/pricing',
    });
    urlInput.value = A.findCardUrl(card);
    var status = el('p', { class: 'status' });
    var result = el('div', { id: 'result' });
    var go = el('button', { type: 'submit', text: 'Scrape' });

    function onSubmit(event) {
      event.preventDefault();
      var url = A.normalizeUrl(urlInput.value);
      result.textContent = '';
      if (!url) {
        setStatus(status, 'error', 'Enter a full web address, such as https://example.com/pricing.');
        return;
      }
      go.disabled = true;
      setStatus(status, '', 'Scraping… this can take up to 2 minutes for heavy pages.');
      A.scrape(fetchFn, apiKey, url)
        .then(function (job) {
          if (!job.markdown) throw new A.ApiError('Anakin found no readable text on this page.', 200, 'empty');
          return resultNodes(job.finalUrl || url, job.markdown, card).then(function (nodes) {
            setStatus(status, '', '');
            nodes.forEach(function (node) {
              result.appendChild(node);
            });
          });
        })
        .catch(function (error) {
          setStatus(status, 'error', A.friendlyError(error));
          if (error instanceof A.ApiError && error.status === 401) {
            result.appendChild(
              el('button', {
                type: 'button',
                class: 'link',
                text: 'Update API key',
                onclick: function () {
                  connectView(apiKey, card);
                },
              })
            );
          }
        })
        .then(function () {
          go.disabled = false;
        });
    }

    show([
      el('div', { class: 'header' }, [
        el('h2', { text: 'Scrape a web page into this card' }),
        el('button', {
          type: 'button',
          class: 'link small',
          text: 'API key',
          onclick: function () {
            connectView(apiKey, card);
          },
        }),
      ]),
      el('form', { onsubmit: onSubmit }, [
        el('div', { class: 'row' }, [
          el('div', { class: 'grow' }, [el('label', { for: 'scrape-url', text: 'Page URL' }), urlInput]),
          go,
        ]),
        status,
      ]),
      result,
    ]);
  }

  /* ---- Start ---- */

  function start() {
    Promise.all([p.card(), p.get('organization', 'private', KEY_NAME)])
      .then(function (results) {
        var card = results[0];
        if (!card) {
          showFatal('Could not load this card. Close it and open it again.');
          return;
        }
        if (results[1]) scrapeView(results[1], card);
        else connectView('', card);
      })
      .catch(function () {
        showFatal('Could not load your Anakin settings from Pipefy. Close the card and open it again.');
      });
  }

  if (typeof window.PipefyApp === 'undefined') {
    showFatal('The Pipefy SDK did not load. Check your connection and reopen this card.');
    return;
  }
  try {
    p = PipefyApp.init();
  } catch (e) {
    showFatal('This page only works inside Pipefy. Open a card and use the Anakin tab.');
    return;
  }
  if (surface === 'card-tab') {
    // Required on a card tab: Pipefy keeps the tab hidden until render() is called.
    PipefyApp.render(function () {
      PipefyApp.resizeTo('#root');
      start();
    });
  } else {
    PipefyApp.resizeTo('#root');
    start();
  }
})();
