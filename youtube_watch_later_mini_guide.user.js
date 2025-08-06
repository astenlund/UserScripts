// ==UserScript==
// @name         YouTube Watch Later Mini Guide
// @namespace    fork-scripts
// @version      0.1
// @description  Adds a Watch Later link to YouTube's mini guide (collapsed sidebar)
// @author       Andreas Stenlund <a.stenlund@gmail.com>
// @match        https://www.youtube.com/*
// @match        https://youtube.com/*
// @grant        none
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/youtube_watch_later_mini_guide.user.js
// @updateURL    https://github.com/astenlund/UserScripts/raw/master/youtube_watch_later_mini_guide.user.js
// ==/UserScript==

(function() {
    'use strict';

    function addWatchLaterToMiniGuide() {
        const miniGuide = document.querySelector('ytd-mini-guide-renderer');
        if (!miniGuide) return;

        // Check if we already added the link
        if (miniGuide.querySelector('[data-custom-watch-later]')) return;

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
        path.setAttribute('d', 'M20.5 12c0 4.694-3.806 8.5-8.5 8.5S3.5 16.694 3.5 12 7.306 3.5 12 3.5s8.5 3.806 8.5 8.5Zm1.5 0c0 5.523-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2s10 4.477 10 10Zm-9.25-5c0-.414-.336-.75-.75-.75s-.75.336-.75.75v5.375l.3.225 4 3c.331.248.802.181 1.05-.15.248-.331.181-.801-.15-1.05l-3.7-2.775V7Z');
        path.setAttribute('fill-rule', 'evenodd');

        svg.appendChild(path);
        iconDiv.appendChild(svg);

        // Create title
        const titleDiv = document.createElement('div');
        titleDiv.className = 'custom-title';
        titleDiv.textContent = 'Watch Later';

        // Assemble
        watchLaterItem.appendChild(iconDiv);
        watchLaterItem.appendChild(titleDiv);

        // Add click handler that delegates to the official Watch Later button
        watchLaterItem.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();

            // Find and click the official Watch Later link in the expanded sidebar
            const expandedWatchLaterLink = document.querySelector('ytd-guide-renderer a[href="/playlist?list=WL"], ytd-guide-renderer a[href*="list=WL"]');
            if (expandedWatchLaterLink) {
                expandedWatchLaterLink.click();
            } else {
                // Fallback: try to expand the sidebar first, then find the button
                const expandButton = document.querySelector('button[aria-label="Guide"]');
                if (expandButton) {
                    expandButton.click();
                    setTimeout(() => {
                        const watchLaterAfterExpand = document.querySelector('ytd-guide-renderer a[href="/playlist?list=WL"], ytd-guide-renderer a[href*="list=WL"]');
                        if (watchLaterAfterExpand) {
                            watchLaterAfterExpand.click();
                            // Collapse sidebar back to mini after a short delay
                            setTimeout(() => {
                                const collapseButton = document.querySelector('button[aria-label="Guide"]');
                                if (collapseButton) {
                                    collapseButton.click();
                                }
                            }, 50);
                        } else {
                            window.location.href = '/playlist?list=WL';
                        }
                    }, 100);
                } else {
                    window.location.href = '/playlist?list=WL';
                }
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

        // Copy styles from existing Subscriptions button
        const subscriptionsButton = Array.from(itemsContainer.children).find(item => {
            const title = item.querySelector('.title');
            return title && title.textContent.trim() === 'Subscriptions';
        });

        if (subscriptionsButton) {
            const computedStyle = window.getComputedStyle(subscriptionsButton);
            const iconElement = subscriptionsButton.querySelector('.guide-icon');
            const titleElement = subscriptionsButton.querySelector('.title');

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

    // Run when page loads
    function init() {
        // Try to add immediately
        addWatchLaterToMiniGuide();

        // Also observe for changes since YouTube is a SPA
        const observer = new MutationObserver(() => {
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