var body = document.querySelector('body')
var menuTrigger = document.querySelector('#toggle-main-menu-mobile');
var menuContainer = document.querySelector('#main-menu-mobile');

menuTrigger.onclick = function() {
    menuContainer.classList.toggle('open');
    menuTrigger.classList.toggle('is-active')
    body.classList.toggle('lock-scroll')
}

document.addEventListener('DOMContentLoaded', function() {
    var iframes = document.querySelectorAll("iframe[data-delayed-src]");

    for (var i = 0; i < iframes.length; i++) {
        var iframe = iframes[i];

        // Check if the iframe is currently in viewport
        checkIframe(iframe);

        // Create an Intersection Observer to watch for when the iframe enters or exits the viewport
        var observer = new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && entry.target == iframe) {
                    // The target is intersecting with the viewport! Load the iFrame src when it's in the viewport
                    loadIframeSrc(iframe);

                    // Stop observing once the element has entered the viewport, to save memory
                    observer.unobserve(entry.target);
                }
            });
        }, { threshold: [0] });

        observer.observe(iframe);
    }
});

function checkIframe(iframe) {
    var rect = iframe.getBoundingClientRect();

    return (
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
        rect.right <= (window.innerWidth || document.documentElement.clientWidth)
    );
}

function loadIframeSrc(iframe) {
    iframe.src = iframe.getAttribute('data-delayed-src');
}

