import { mount } from './features.js';

const list = document.querySelector('#items');

async function load() {
  const items = await (await fetch('/api/items')).json();
  list.replaceChildren(...items.map((item) => {
    const li = document.createElement('li');
    li.textContent = item.title;
    const del = document.createElement('button');
    del.textContent = 'Remove';
    del.addEventListener('click', async () => {
      await fetch(`/api/items/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      load();
    });
    li.append(' ', del);
    return li;
  }));
}

document.querySelector('#item-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = new FormData(e.target).get('title');
  await fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: crypto.randomUUID(), title }) });
  e.target.reset();
  load();
});

Promise.all([load(), Promise.resolve(mount(document.querySelector('#features')))])
  .then(() => document.body.setAttribute('data-ready', 'true'))
  .catch(() => document.body.setAttribute('data-ready', 'error'));
