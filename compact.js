/* 上下文压缩：请求超过阈值时，把较早的消息压成一张「记忆卡」再发送。
 * 本地记录不动，只改发出去的内容。
 */
(function () {
  'use strict';

  var API_HOST = 'api.deepseek.com';
  var ENDPOINT = '/anthropic/v1/messages';
  var MAX_CHARS = 60000;   // 会话正文超过这个长度就触发压缩
  var KEEP_TAIL = 6;       // 最近几条原样保留
  var MEM_PREFIX = 'dsc-mem:';
  var busy = false;

  var origFetch = window.fetch.bind(window);

  function textOf(message) {
    if (!message || !message.content) return '';
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map(function (block) {
          if (!block) return '';
          if (block.type === 'text') return block.text || '';
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    return '';
  }

  function isPlain(message) {
    if (!message) return false;
    if (typeof message.content === 'string') return true;
    if (!Array.isArray(message.content)) return false;
    return message.content.every(function (block) {
      return block && block.type === 'text';
    });
  }

  function charCount(messages) {
    var total = 0;
    for (var i = 0; i < messages.length; i += 1) total += textOf(messages[i]).length;
    return total;
  }

  function memoryKey(messages) {
    for (var i = 0; i < messages.length; i += 1) {
      if (messages[i].role === 'user') {
        return MEM_PREFIX + textOf(messages[i]).slice(0, 48);
      }
    }
    return MEM_PREFIX + 'default';
  }

  function readMemory(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function writeMemory(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      /* 存储不可用时忽略，压缩仍然可以临时生效 */
    }
  }

  function buildPrompt(previous, messages) {
    var lines = messages.map(function (message) {
      var label = message.role === 'assistant' ? '助手' : message.role === 'user' ? '用户' : message.role;
      return label + '：' + textOf(message).slice(0, 2000);
    });
    return [
      '你是上下文压缩器。把下面的对话压成一张「记忆卡」，供后续对话继续使用。',
      '',
      '要求：',
      '- 只保留：用户的目标与约束、已达成的结论或决定、关键事实与数据、未完成的任务、用户的偏好；',
      '- 每条一行，以「- 」开头，最多 20 行，总长不超过 600 字；',
      '- 不要客套话，不要复述原文，不要编造；',
      '- 如果给了「已有记忆卡」，把它和新内容合并去重。',
      '- 只输出记忆卡正文。',
      '',
      previous ? '已有记忆卡：\n' + previous + '\n' : '',
      '对话记录：',
      lines.join('\n')
    ]
      .filter(function (line) {
        return line !== '';
      })
      .join('\n');
  }

  function summarize(prompt, template) {
    var body = {
      model: template.model || 'deepseek-flash',
      max_tokens: 900,
      stream: false,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    };
    if (template.system) body.system = template.system;

    return origFetch('https://' + API_HOST + ENDPOINT, {
      method: 'POST',
      headers: template.headers || { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        var text = '';
        if (data && Array.isArray(data.content)) {
          text = data.content
            .filter(function (block) {
              return block && block.type === 'text';
            })
            .map(function (block) {
              return block.text || '';
            })
            .join('\n');
        } else if (data && typeof data.completion === 'string') {
          text = data.completion;
        }
        return text.trim();
      });
  }

  function applyCard(messages, card) {
    var tail = messages.slice(-KEEP_TAIL);
    if (!tail.length) return messages;

    var head = '[上下文记忆卡｜早期对话已压缩]\n' + card + '\n[以上是压缩前的要点，请据此继续]';

    if (tail[0] && tail[0].role === 'user') {
      var merged = JSON.parse(JSON.stringify(tail));
      var text = textOf(merged[0]);
      merged[0].content = [{ type: 'text', text: head + '\n\n' + text }];
      return merged;
    }

    return [{ role: 'user', content: [{ type: 'text', text: head }] }].concat(tail);
  }

  function compactBody(body, headers) {
    var messages = body.messages;
    if (!Array.isArray(messages) || messages.length <= KEEP_TAIL + 2) return Promise.resolve(null);
    if (charCount(messages) < MAX_CHARS) return Promise.resolve(null);

    var older = messages.slice(0, messages.length - KEEP_TAIL);
    if (!older.every(isPlain)) return Promise.resolve(null);

    var key = memoryKey(messages);
    var memory = readMemory(key);
    var covered = memory && typeof memory.covered === 'number' ? memory.covered : 0;

    if (memory && memory.summary && covered >= older.length) {
      return Promise.resolve(Object.assign({}, body, { messages: applyCard(messages, memory.summary) }));
    }

    var pending = covered > 0 && covered < older.length ? older.slice(covered) : older;
    var previous = covered > 0 && memory ? memory.summary : '';
    var prompt = buildPrompt(previous, pending);

    return summarize(prompt, { model: body.model, system: body.system, headers: headers })
      .then(function (card) {
        if (!card) return null;
        writeMemory(key, { summary: card, covered: older.length });
        return Object.assign({}, body, { messages: applyCard(messages, card) });
      })
      .catch(function () {
        return null;
      });
  }

  window.fetch = function (input, init) {
    try {
      var isRequest = typeof Request !== 'undefined' && input instanceof Request;
      var url = isRequest ? input.url : String(input);
      if (url.indexOf(API_HOST) === -1 || url.indexOf(ENDPOINT) === -1) {
        return origFetch(input, init);
      }
      if (busy) return origFetch(input, init);

      var bodyPromise;
      if (isRequest) {
        bodyPromise = input.clone().text();
      } else if (init && typeof init.body === 'string') {
        bodyPromise = Promise.resolve(init.body);
      } else {
        bodyPromise = Promise.resolve(null);
      }

      return bodyPromise
        .then(function (raw) {
          if (!raw) return origFetch(input, init);
          var body;
          try {
            body = JSON.parse(raw);
          } catch (error) {
            return origFetch(input, init);
          }
          if (!body || !Array.isArray(body.messages)) return origFetch(input, init);

          var headers = {};
          if (isRequest) {
            input.headers.forEach(function (value, name) {
              headers[name] = value;
            });
          } else if (init && init.headers) {
            var source = init.headers;
            if (typeof Headers !== 'undefined' && source instanceof Headers) {
              source.forEach(function (value, name) {
                headers[name] = value;
              });
            } else if (Array.isArray(source)) {
              source.forEach(function (pair) {
                headers[pair[0]] = pair[1];
              });
            } else {
              headers = source;
            }
          }

          busy = true;
          return compactBody(body, headers)
            .then(function (next) {
              busy = false;
              if (!next) return origFetch(input, init);
              var target = isRequest ? input.url : String(input);
              return origFetch(target, {
                method: (init && init.method) || (isRequest ? input.method : 'POST'),
                headers: headers,
                body: JSON.stringify(next),
                signal: (init && init.signal) || undefined
              });
            })
            .catch(function (error) {
              busy = false;
              return origFetch(input, init);
            });
        })
        .catch(function () {
          return origFetch(input, init);
        });
    } catch (error) {
      return origFetch(input, init);
    }
  };
})();
