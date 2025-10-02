// ==UserScript==
// @name         YouTube Watch Later & Courses Mini Guide
// @namespace    fork-scripts
// @version      0.5
// @description  Adds Watch Later and Your Courses links to YouTube's mini guide (collapsed sidebar)
// @author       Andreas Stenlund <a.stenlund@gmail.com>
// @match        https://www.youtube.com/*
// @match        https://youtube.com/*
// @grant        none
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/youtube_watch_later_mini_guide.user.js
// @updateURL    https://github.com/astenlund/UserScripts/raw/master/youtube_watch_later_mini_guide.user.js
// ==/UserScript==

(function() {
    'use strict';

    function getSvgPathForWatchLaterIcon() {
        const isOnWatchLater = window.location.href.includes('list=WL');
        if (isOnWatchLater) {
            // Filled clock icon for when we're on the Watch Later page (YouTube's exact SVG)
            return 'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10Zm1-15c0-.552-.448-1-1-1s-1 .448-1 1v5.5l.4.3 4 3c.442.331 1.069.242 1.4-.2.331-.442.242-1.069-.2-1.4L13 11.5V7Z';
        } else {
            // Unfilled clock icon for other pages
            return 'M20.5 12c0 4.694-3.806 8.5-8.5 8.5S3.5 16.694 3.5 12 7.306 3.5 12 3.5s8.5 3.806 8.5 8.5Zm1.5 0c0 5.523-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2s10 4.477 10 10Zm-9.25-5c0-.414-.336-.75-.75-.75s-.75.336-.75.75v5.375l.3.225 4 3c.331.248.802.181 1.05-.15.248-.331.181-.801-.15-1.05l-3.7-2.775V7Z';
        }
    }

    function getSvgPathForCoursesIcon() {
        const isOnCourses = window.location.href.includes('/feed/courses');
        if (isOnCourses) {
            // Filled graduation cap icon for when we're on the Courses page (returns array with two paths)
            return ['M12.728 2.689a1.5 1.5 0 00-1.457 0l-9 5a1.5 1.5 0 000 2.622l9 5a1.5 1.5 0 001.457 0L21 10.716V16a.75.75 0 001.5 0V9a1.5 1.5 0 00-.771-1.311l-9-5Z', 'M4.5 17v-3.734l6.043 3.357a3 3 0 002.914 0l6.043-3.357V17a.75.75 0 01-.741.75c-1.9.023-3.076.401-3.941.897-.71.407-1.229.894-1.817 1.447-.159.149-.322.303-.496.46a.75.75 0 01-1.046-.034l-.076-.08c-.702-.73-1.303-1.355-2.164-1.831-.875-.485-2.074-.84-3.976-.859A.75.75 0 014.5 17Z'];
        } else {
            // Unfilled graduation cap icon for other pages
            return 'M11.271 2.689a1.5 1.5 0 011.457 0l9 5A1.5 1.5 0 0122.5 9v7a.75.75 0 01-1.5 0v-5.284l-1.5.833V17a.75.75 0 01-.741.75c-1.9.023-3.076.4-3.941.896-.71.407-1.229.895-1.817 1.448-.159.149-.322.302-.496.46a.75.75 0 01-1.046-.034l-.076-.08c-.702-.73-1.303-1.355-2.164-1.832-.875-.485-2.074-.84-3.976-.858A.75.75 0 014.5 17v-5.45l-2.228-1.24a1.5 1.5 0 010-2.622l9-5ZM6 12.383v3.891c1.703.096 2.946.468 3.946 1.022.858.475 1.508 1.07 2.08 1.652.575-.54 1.221-1.13 2.046-1.603.988-.566 2.215-.963 3.928-1.068v-3.894l-5.272 2.928a1.5 1.5 0 01-1.457 0L6 12.383ZM12 4l9 5-9 5-9-5 9-5Z';
        }
    }

    function addWatchLaterToMiniGuide() {
        const miniGuide = document.querySelector('ytd-mini-guide-renderer');
        if (!miniGuide) return;

        // Check if we already added the link
        const existingButton = miniGuide.querySelector('[data-custom-watch-later]');
        if (existingButton) {
            // Update the icon based on current page
            const path = existingButton.querySelector('svg path');
            if (path) {
                path.setAttribute('d', getSvgPathForWatchLaterIcon());
            }
            return;
        }

        // Find the items container
        const itemsContainer = miniGuide.querySelector('#items');
        if (!itemsContainer) return;

        // Create a simple div instead of trying to mimic YouTube's complex elements
        const watchLaterItem = document.createElement('div');
        watchLaterItem.className = 'custom-watch-later-button';
        watchLaterItem.setAttribute('data-custom-watch-later', 'true');

        // Create icon (proper SVG from YouTube, built programmatically)
        const iconDiv = document.createElement('div');
        iconDiv.className = 'custom-icon';

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('fill', 'currentColor');
        svg.setAttribute('height', '24');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', '24');
        svg.setAttribute('focusable', 'false');
        svg.setAttribute('aria-hidden', 'true');
        svg.style.pointerEvents = 'none';
        svg.style.display = 'inherit';
        svg.style.width = '100%';
        svg.style.height = '100%';

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('clip-rule', 'evenodd');
        path.setAttribute('fill-rule', 'evenodd');

        // Set the appropriate SVG path based on current page
        path.setAttribute('d', getSvgPathForWatchLaterIcon());

        svg.appendChild(path);
        iconDiv.appendChild(svg);

        // Create title
        const titleDiv = document.createElement('div');
        titleDiv.className = 'custom-title';
        titleDiv.textContent = 'Watch Later';

        // Assemble
        watchLaterItem.appendChild(iconDiv);
        watchLaterItem.appendChild(titleDiv);

        // Add handler function that delegates to the official Watch Later button
        function handleWatchLaterAction(e) {
            e.preventDefault();
            e.stopPropagation();

            const WATCH_LATER_SELECTOR = 'ytd-guide-renderer a[href="/playlist?list=WL"], ytd-guide-renderer a[href*="list=WL"]';
            const GUIDE_BUTTON_SELECTOR = 'button[aria-label="Guide"]';
            
            // Helper to find and click Watch Later link
            function clickWatchLaterLink(shouldCollapse = false) {
                const watchLaterLink = document.querySelector(WATCH_LATER_SELECTOR);
                if (watchLaterLink) {
                    watchLaterLink.click();
                    if (shouldCollapse) {
                        setTimeout(() => {
                            const collapseButton = document.querySelector(GUIDE_BUTTON_SELECTOR);
                            if (collapseButton) collapseButton.click();
                        }, 50);
                    }
                    return true;
                }
                return false;
            }
            
            // Try clicking if already visible
            if (clickWatchLaterLink()) return;
            
            // Otherwise, expand sidebar and try
            const expandButton = document.querySelector(GUIDE_BUTTON_SELECTOR);
            if (!expandButton) {
                console.warn('YouTube Watch Later Mini Guide: Could not find sidebar expand button');
                return;
            }
            
            expandButton.click();
            
            // Try with retries
            const delays = [300, 300]; // Two attempts with 300ms delays
            let attemptIndex = 0;
            
            function attemptClick() {
                if (clickWatchLaterLink(true)) return;
                
                if (attemptIndex < delays.length) {
                    setTimeout(attemptClick, delays[attemptIndex++]);
                } else {
                    // Final failure - log and close sidebar
                    console.warn('YouTube Watch Later Mini Guide: Could not find Watch Later link in sidebar');
                    const collapseButton = document.querySelector(GUIDE_BUTTON_SELECTOR);
                    if (collapseButton) collapseButton.click();
                }
            }
            
            setTimeout(attemptClick, delays[attemptIndex++]);
        }

        // Add both click and touch event handlers
        watchLaterItem.addEventListener('click', handleWatchLaterAction);

        // Add touch event handling
        let touchStarted = false;
        watchLaterItem.addEventListener('touchstart', function(e) {
            touchStarted = true;
        }, { passive: true });

        watchLaterItem.addEventListener('touchend', function(e) {
            if (touchStarted) {
                touchStarted = false;
                handleWatchLaterAction(e);
            }
        });

        // Find position to insert (after Subscriptions)
        const subscriptionsItem = Array.from(itemsContainer.children).find(item => {
            const title = item.querySelector('.title');
            return title && title.textContent.trim() === 'Subscriptions';
        });

        if (subscriptionsItem && subscriptionsItem.nextSibling) {
            itemsContainer.insertBefore(watchLaterItem, subscriptionsItem.nextSibling);
        } else {
            // If we can't find Subscriptions, add it after the third item
            const fourthItem = itemsContainer.children[3];
            if (fourthItem) {
                itemsContainer.insertBefore(watchLaterItem, fourthItem);
            } else {
                itemsContainer.appendChild(watchLaterItem);
            }
        }

        // Copy styles from existing Subscriptions button with retry mechanism
        function copyStylesFromSubscriptions() {
            const subscriptionsButton = Array.from(itemsContainer.children).find(item => {
                const title = item.querySelector('.title');
                return title && title.textContent.trim() === 'Subscriptions';
            });

            if (subscriptionsButton) {
                const computedStyle = window.getComputedStyle(subscriptionsButton);
                const iconElement = subscriptionsButton.querySelector('.guide-icon');
                const titleElement = subscriptionsButton.querySelector('.title');

                // Check if styles are properly loaded (height should be > 0)
                if (computedStyle.height === '0px' || computedStyle.height === 'auto') {
                    return false; // Styles not ready yet
                }

                // Apply computed styles to our button
                watchLaterItem.style.width = computedStyle.width;
                watchLaterItem.style.height = computedStyle.height;
                watchLaterItem.style.display = computedStyle.display;
                watchLaterItem.style.flexDirection = computedStyle.flexDirection;
                watchLaterItem.style.alignItems = computedStyle.alignItems;
                watchLaterItem.style.justifyContent = computedStyle.justifyContent;
                watchLaterItem.style.padding = computedStyle.padding;
                watchLaterItem.style.margin = computedStyle.margin;
                watchLaterItem.style.borderRadius = computedStyle.borderRadius;
                watchLaterItem.style.cursor = computedStyle.cursor;
                watchLaterItem.style.boxSizing = computedStyle.boxSizing;
                watchLaterItem.style.background = computedStyle.background;
                watchLaterItem.style.border = computedStyle.border;

                // Copy icon styles
                if (iconElement) {
                    const iconStyle = window.getComputedStyle(iconElement);
                    iconDiv.style.width = iconStyle.width;
                    iconDiv.style.height = iconStyle.height;
                    iconDiv.style.margin = iconStyle.margin;
                    iconDiv.style.marginBottom = iconStyle.marginBottom;
                    iconDiv.style.marginTop = iconStyle.marginTop;
                    iconDiv.style.display = iconStyle.display;
                    iconDiv.style.alignItems = iconStyle.alignItems;
                    iconDiv.style.justifyContent = iconStyle.justifyContent;
                    iconDiv.style.color = iconStyle.color;
                }

                // Copy title styles
                if (titleElement) {
                    const titleStyle = window.getComputedStyle(titleElement);
                    titleDiv.style.color = titleStyle.color;
                    titleDiv.style.fontFamily = titleStyle.fontFamily;
                    titleDiv.style.fontSize = titleStyle.fontSize;
                    titleDiv.style.lineHeight = titleStyle.lineHeight;
                    titleDiv.style.fontWeight = titleStyle.fontWeight;
                    titleDiv.style.textAlign = titleStyle.textAlign;
                    titleDiv.style.display = titleStyle.display;
                    titleDiv.style.maxWidth = titleStyle.maxWidth;
                    titleDiv.style.wordWrap = titleStyle.wordWrap;
                }

                // Add hover styles by creating CSS rules that match YouTube's behavior
                const hoverStyle = document.createElement('style');
                hoverStyle.textContent = `
                    .custom-watch-later-button:hover {
                        background-color: rgba(255, 255, 255, 0.1) !important;
                    }

                    html:not([dark]) .custom-watch-later-button:hover {
                        background-color: rgba(0, 0, 0, 0.05) !important;
                    }
                `;
                if (!document.querySelector('#custom-watch-later-hover-style')) {
                    hoverStyle.id = 'custom-watch-later-hover-style';
                    document.head.appendChild(hoverStyle);
                }

                return true; // Successfully copied styles
            }
            return false; // Failed to find subscriptions button or styles not ready
        }

        // Try to copy styles immediately, then retry if needed
        if (!copyStylesFromSubscriptions()) {
            // If first attempt failed, try again after a short delay
            setTimeout(() => {
                if (!copyStylesFromSubscriptions()) {
                    // If second attempt failed, try once more after a longer delay
                    setTimeout(() => {
                        copyStylesFromSubscriptions();
                    }, 500);
                }
            }, 100);
        } else {
            // Fallback to our custom styles if Subscriptions button not found
            const style = document.createElement('style');
            style.textContent = `
                .custom-watch-later-button {
                    display: flex !important;
                    flex-direction: column !important;
                    align-items: center !important;
                    justify-content: center !important;
                    width: 64px !important;
                    height: 74px !important;
                    cursor: pointer !important;
                    padding: 0 !important;
                    margin: 0 !important;
                    box-sizing: border-box !important;
                    background: transparent !important;
                    border: none !important;
                    border-radius: 10px !important;
                }
            `;
            if (!document.querySelector('#custom-watch-later-style')) {
                style.id = 'custom-watch-later-style';
                document.head.appendChild(style);
            }
        }
    }

    function addCoursesToMiniGuide() {
        const miniGuide = document.querySelector('ytd-mini-guide-renderer');
        if (!miniGuide) return;

        // Check if we already added the link
        const existingButton = miniGuide.querySelector('[data-custom-courses]');
        if (existingButton) {
            // Update the icon based on current page (only if it needs updating)
            const svg = existingButton.querySelector('svg');
            if (svg) {
                const pathData = getSvgPathForCoursesIcon();
                const currentPaths = Array.from(svg.querySelectorAll('path')).map(p => p.getAttribute('d'));
                const newPaths = Array.isArray(pathData) ? pathData : [pathData];

                // Only update if paths have changed
                const pathsMatch = currentPaths.length === newPaths.length &&
                                   currentPaths.every((p, i) => p === newPaths[i]);

                if (!pathsMatch) {
                    // Clear existing paths
                    while (svg.firstChild) {
                        svg.removeChild(svg.firstChild);
                    }

                    // Add new paths
                    if (Array.isArray(pathData)) {
                        pathData.forEach(d => {
                            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                            path.setAttribute('d', d);
                            svg.appendChild(path);
                        });
                    } else {
                        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                        path.setAttribute('clip-rule', 'evenodd');
                        path.setAttribute('fill-rule', 'evenodd');
                        path.setAttribute('d', pathData);
                        svg.appendChild(path);
                    }
                }
            }
            return;
        }

        // Find the items container
        const itemsContainer = miniGuide.querySelector('#items');
        if (!itemsContainer) return;

        // Create a simple div
        const coursesItem = document.createElement('div');
        coursesItem.className = 'custom-courses-button';
        coursesItem.setAttribute('data-custom-courses', 'true');

        // Create icon
        const iconDiv = document.createElement('div');
        iconDiv.className = 'custom-icon';

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('fill', 'currentColor');
        svg.setAttribute('height', '24');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', '24');
        svg.setAttribute('focusable', 'false');
        svg.setAttribute('aria-hidden', 'true');
        svg.style.pointerEvents = 'none';
        svg.style.display = 'inherit';
        svg.style.width = '100%';
        svg.style.height = '100%';

        const pathData = getSvgPathForCoursesIcon();
        if (Array.isArray(pathData)) {
            // Multiple paths for filled icon
            pathData.forEach(d => {
                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                path.setAttribute('d', d);
                svg.appendChild(path);
            });
        } else {
            // Single path for unfilled icon
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('clip-rule', 'evenodd');
            path.setAttribute('fill-rule', 'evenodd');
            path.setAttribute('d', pathData);
            svg.appendChild(path);
        }

        iconDiv.appendChild(svg);

        // Create title
        const titleDiv = document.createElement('div');
        titleDiv.className = 'custom-title';
        titleDiv.textContent = 'Your courses';

        // Assemble
        coursesItem.appendChild(iconDiv);
        coursesItem.appendChild(titleDiv);

        // Add handler function that delegates to the official Courses button
        function handleCoursesAction(e) {
            e.preventDefault();
            e.stopPropagation();

            const COURSES_SELECTOR = 'ytd-guide-renderer a[href="/feed/courses"]';
            const GUIDE_BUTTON_SELECTOR = 'button[aria-label="Guide"]';

            // Helper to find and click Courses link
            function clickCoursesLink(shouldCollapse = false) {
                const coursesLink = document.querySelector(COURSES_SELECTOR);
                if (coursesLink) {
                    coursesLink.click();
                    if (shouldCollapse) {
                        setTimeout(() => {
                            const collapseButton = document.querySelector(GUIDE_BUTTON_SELECTOR);
                            if (collapseButton) collapseButton.click();
                        }, 50);
                    }
                    return true;
                }
                return false;
            }

            // Try clicking if already visible
            if (clickCoursesLink()) return;

            // Otherwise, expand sidebar and try
            const expandButton = document.querySelector(GUIDE_BUTTON_SELECTOR);
            if (!expandButton) {
                console.warn('YouTube Courses Mini Guide: Could not find sidebar expand button');
                return;
            }

            expandButton.click();

            // Try with retries
            const delays = [300, 300]; // Two attempts with 300ms delays
            let attemptIndex = 0;

            function attemptClick() {
                if (clickCoursesLink(true)) return;

                if (attemptIndex < delays.length) {
                    setTimeout(attemptClick, delays[attemptIndex++]);
                } else {
                    // Final failure - log and close sidebar
                    console.warn('YouTube Courses Mini Guide: Could not find Courses link in sidebar');
                    const collapseButton = document.querySelector(GUIDE_BUTTON_SELECTOR);
                    if (collapseButton) collapseButton.click();
                }
            }

            setTimeout(attemptClick, delays[attemptIndex++]);
        }

        // Add both click and touch event handlers
        coursesItem.addEventListener('click', handleCoursesAction);

        // Add touch event handling
        let touchStarted = false;
        coursesItem.addEventListener('touchstart', function(e) {
            touchStarted = true;
        }, { passive: true });

        coursesItem.addEventListener('touchend', function(e) {
            if (touchStarted) {
                touchStarted = false;
                handleCoursesAction(e);
            }
        });

        // Find position to insert (after Subscriptions, before Watch Later if it exists)
        const subscriptionsItem = Array.from(itemsContainer.children).find(item => {
            const title = item.querySelector('.title');
            return title && title.textContent.trim() === 'Subscriptions';
        });

        if (subscriptionsItem && subscriptionsItem.nextSibling) {
            itemsContainer.insertBefore(coursesItem, subscriptionsItem.nextSibling);
        } else {
            // If we can't find Subscriptions, add it after the third item
            const fourthItem = itemsContainer.children[3];
            if (fourthItem) {
                itemsContainer.insertBefore(coursesItem, fourthItem);
            } else {
                itemsContainer.appendChild(coursesItem);
            }
        }

        // Copy styles from existing Subscriptions button with retry mechanism
        function copyStylesFromSubscriptions() {
            const subscriptionsButton = Array.from(itemsContainer.children).find(item => {
                const title = item.querySelector('.title');
                return title && title.textContent.trim() === 'Subscriptions';
            });

            if (subscriptionsButton) {
                const computedStyle = window.getComputedStyle(subscriptionsButton);
                const iconElement = subscriptionsButton.querySelector('.guide-icon');
                const titleElement = subscriptionsButton.querySelector('.title');

                // Check if styles are properly loaded (height should be > 0)
                if (computedStyle.height === '0px' || computedStyle.height === 'auto') {
                    return false; // Styles not ready yet
                }

                // Apply computed styles to our button
                coursesItem.style.width = computedStyle.width;
                coursesItem.style.height = computedStyle.height;
                coursesItem.style.display = computedStyle.display;
                coursesItem.style.flexDirection = computedStyle.flexDirection;
                coursesItem.style.alignItems = computedStyle.alignItems;
                coursesItem.style.justifyContent = computedStyle.justifyContent;
                coursesItem.style.padding = computedStyle.padding;
                coursesItem.style.margin = computedStyle.margin;
                coursesItem.style.borderRadius = computedStyle.borderRadius;
                coursesItem.style.cursor = computedStyle.cursor;
                coursesItem.style.boxSizing = computedStyle.boxSizing;
                coursesItem.style.background = computedStyle.background;
                coursesItem.style.border = computedStyle.border;

                // Copy icon styles
                if (iconElement) {
                    const iconStyle = window.getComputedStyle(iconElement);
                    iconDiv.style.width = iconStyle.width;
                    iconDiv.style.height = iconStyle.height;
                    iconDiv.style.margin = iconStyle.margin;
                    iconDiv.style.marginBottom = iconStyle.marginBottom;
                    iconDiv.style.marginTop = iconStyle.marginTop;
                    iconDiv.style.display = iconStyle.display;
                    iconDiv.style.alignItems = iconStyle.alignItems;
                    iconDiv.style.justifyContent = iconStyle.justifyContent;
                    iconDiv.style.color = iconStyle.color;
                }

                // Copy title styles
                if (titleElement) {
                    const titleStyle = window.getComputedStyle(titleElement);
                    titleDiv.style.color = titleStyle.color;
                    titleDiv.style.fontFamily = titleStyle.fontFamily;
                    titleDiv.style.fontSize = titleStyle.fontSize;
                    titleDiv.style.lineHeight = titleStyle.lineHeight;
                    titleDiv.style.fontWeight = titleStyle.fontWeight;
                    titleDiv.style.textAlign = titleStyle.textAlign;
                    titleDiv.style.display = titleStyle.display;
                    titleDiv.style.maxWidth = titleStyle.maxWidth;
                    titleDiv.style.wordWrap = titleStyle.wordWrap;
                }

                // Add hover styles by creating CSS rules that match YouTube's behavior
                const hoverStyle = document.createElement('style');
                hoverStyle.textContent = `
                    .custom-courses-button:hover {
                        background-color: rgba(255, 255, 255, 0.1) !important;
                    }

                    html:not([dark]) .custom-courses-button:hover {
                        background-color: rgba(0, 0, 0, 0.05) !important;
                    }
                `;
                if (!document.querySelector('#custom-courses-hover-style')) {
                    hoverStyle.id = 'custom-courses-hover-style';
                    document.head.appendChild(hoverStyle);
                }

                return true; // Successfully copied styles
            }
            return false; // Failed to find subscriptions button or styles not ready
        }

        // Try to copy styles immediately, then retry if needed
        if (!copyStylesFromSubscriptions()) {
            // If first attempt failed, try again after a short delay
            setTimeout(() => {
                if (!copyStylesFromSubscriptions()) {
                    // If second attempt failed, try once more after a longer delay
                    setTimeout(() => {
                        copyStylesFromSubscriptions();
                    }, 500);
                }
            }, 100);
        } else {
            // Fallback to our custom styles if Subscriptions button not found
            const style = document.createElement('style');
            style.textContent = `
                .custom-courses-button {
                    display: flex !important;
                    flex-direction: column !important;
                    align-items: center !important;
                    justify-content: center !important;
                    width: 64px !important;
                    height: 74px !important;
                    cursor: pointer !important;
                    padding: 0 !important;
                    margin: 0 !important;
                    box-sizing: border-box !important;
                    background: transparent !important;
                    border: none !important;
                    border-radius: 10px !important;
                }
            `;
            if (!document.querySelector('#custom-courses-style')) {
                style.id = 'custom-courses-style';
                document.head.appendChild(style);
            }
        }
    }

    // Run when page loads
    function init() {
        // Try to add immediately
        addCoursesToMiniGuide();
        addWatchLaterToMiniGuide();

        // Also observe for changes since YouTube is a SPA
        const observer = new MutationObserver(() => {
            addCoursesToMiniGuide();
            addWatchLaterToMiniGuide();
        });

        // Observe the app for changes
        const app = document.querySelector('ytd-app');
        if (app) {
            observer.observe(app, {
                childList: true,
                subtree: true
            });
        }
    }

    // Wait for the page to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        // Delay slightly to ensure YouTube's elements are loaded
        setTimeout(init, 1000);
    }
})();
