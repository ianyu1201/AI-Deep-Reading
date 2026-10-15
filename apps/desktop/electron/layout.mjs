// Logical pixels. A user's panel intent is independent from responsive collapse.
export function workspaceLayout({ width, height, view, readingTab, workbenchNote=false, bookOpen, chatVisible = true, chatExpanded=false, compactChat=false, immersive = false, sidebarCollapsed = true, preferredChatWidth=null }) {
  const childToolbar = ['books','epub','markdown'].includes(view) || workbenchNote || readingTab === 'original' && bookOpen;
  const top = immersive ? 0 : childToolbar ? 48 : 96;
  const railWidth = immersive ? 0 : 60;
  const minContent = 480, minChat = 340, dividerWidth = 6;
  const narrow = width - railWidth < minContent + minChat + dividerWidth;
  const showChat = !immersive && view !== 'books' && chatVisible && (!narrow || compactChat || chatExpanded);
  const fullChat = showChat && (narrow || chatExpanded);
  const wantsSidebar = false; // Notes now live inside the right tool panel.
  const sidebarWidth = wantsSidebar && width - railWidth >= 220 + (showChat ? minContent + minChat + dividerWidth : Math.min(minContent,width-railWidth-220)) ? 220 : 0;
  const availableWidth = width - railWidth - sidebarWidth;
  const chatMax = Math.max(minChat, availableWidth - minContent - dividerWidth);
  const chatWidth = showChat ? fullChat ? width - railWidth : Math.round(Math.max(minChat, Math.min(chatMax, preferredChatWidth ?? availableWidth * .32))) : 0;
  const splitWidth = showChat && !fullChat ? dividerWidth : 0;
  const content = { x: railWidth + sidebarWidth, y: top, width: Math.max(1, availableWidth - (fullChat ? 0 : chatWidth + splitWidth)), height: Math.max(1, height - top) };
  const reader = ['books','epub'].includes(view) ? 'books' : view === 'markdown' || view === 'reading' && workbenchNote ? 'markdown' : readingTab === 'original' && bookOpen ? 'books' : null;
  return { top, narrow, showChat, fullChat, chatWidth, chatMin:minChat, chatMax, railWidth, splitWidth, sidebarWidth, responsiveSidebarCollapsed:wantsSidebar&&!sidebarWidth, content, visibleReader: fullChat ? null : reader };
}
