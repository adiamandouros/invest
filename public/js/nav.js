// On phones the page links scroll sideways (style.css .site-pages): bring
// the current page's link into view, without moving the page itself
const list = document.querySelector('.site-pages');
const current = list?.querySelector('[aria-current="page"]');
if (list && current && list.scrollWidth > list.clientWidth) {
    list.scrollLeft = current.offsetLeft - list.offsetLeft - (list.clientWidth - current.offsetWidth) / 2;
}
