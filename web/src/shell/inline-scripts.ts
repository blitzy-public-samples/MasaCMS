// Inline scripts of the full and compact admin layouts, `template.cfm` 326-557 and `compact.cfm` 139-300 (server-only).
import { legacySettings } from '@/lib/env';
import { encodeJs, raw, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { siteBeanOf, sitePaths, type SiteBean } from '@/lib/site-paths';
import type { ShellContext } from './types';

/** Site values of the `Mura.init` call. */
interface MuraInitSite {
  readonly siteId: string;
  readonly themeAssetPath: string;
  readonly assetPath: string;
  readonly corePath: string;
  readonly fileAssetPath: string;
  readonly adminPath: string;
  readonly pluginsPath: string;
  readonly rootPath: string;
}

// programs-sites serves site data to private admin users for their token's site only; otherwise the session site is
// taken to be served on the request host with its own pools and no theme, since its row cannot be read.
/** The session site's bean when no site data was served for it. */
function unreadSiteBean(ctx: AdminRequest): SiteBean {
  const siteId = ctx.session.siteid !== '' ? ctx.session.siteid : 'default';
  return {
    siteId,
    domain: ctx.serverName,
    domainAliases: [],
    enforcePrimaryDomain: false,
    useSSL: false,
    isRemote: false,
    remoteContext: '',
    remotePort: 80,
    resourceSSL: false,
    resourceDomain: '',
    displayPoolID: siteId,
    filePoolID: siteId,
    theme: '',
  };
}

/** settingsBean `get<X>Path(complete=1)` of `site` for an admin request. */
function muraInitSite(ctx: AdminRequest, site: SiteBean): MuraInitSite {
  const paths = sitePaths(ctx, site);
  return {
    siteId: site.siteId,
    // Web cannot reach legacy theme directories; a Masa 7.6.1 install keeps them in the web root (EX-SHELL-THEMEPATH).
    themeAssetPath: paths.themeAssetPath('webRoot', true),
    assetPath: paths.assetPath(true),
    corePath: paths.corePath(true),
    fileAssetPath: paths.fileAssetPath(true),
    adminPath: paths.adminPath(true),
    pluginsPath: paths.pluginsPath(true),
    rootPath: paths.rootPath(true),
  };
}

/** `session.frontEndProxyLoc` after `compact.cfm` 86-91: a non-empty `rc.frontEndProxyLoc`, else the stored value. */
function effectiveFrontEndProxyLoc(ctx: AdminRequest): string {
  const requested = ctx.rc.frontEndProxyLoc ?? '';
  return requested !== '' ? requested : ctx.session.frontEndProxyLoc;
}

/** The `Mura.init({…});` statement ending both layout scripts, for the session site, indented as legacy emits it. */
export function renderMuraInit(sc: ShellContext): string {
  const { context, indexFileInAPI } = legacySettings();
  const site = muraInitSite(sc.ctx, sc.ctx.site === undefined ? unreadSiteBean(sc.ctx) : siteBeanOf(sc.ctx.site));
  // settingsBean has no getSitesPath, so `sitespath` is the '' its missing-method getter returns.
  return `Mura.init({
				inAdmin:true,
				context:'${encodeJs(context)}',
				themepath:'${encodeJs(site.themeAssetPath)}',
				siteid:'${encodeJs(site.siteId)}',
				assetpath:'${encodeJs(site.assetPath)}',
				sitespath:'',
				corepath:'${encodeJs(site.corePath)}',
				fileassetpath:'${encodeJs(site.fileAssetPath)}',
				adminpath:'${encodeJs(site.adminPath)}',
				themepath:'${encodeJs(site.themeAssetPath)}',
				pluginspath:'${encodeJs(site.pluginsPath)}',
				rootpath:'${encodeJs(site.rootPath)}',
				indexfileinapi: ${String(indexFileInAPI)}
			});`;
}

/** The full layout's `<script>…</script>` (`template.cfm` 326-557); `template.ts` omits it on `clogin.main`. */
export function renderTemplateScripts(sc: ShellContext): SafeHtml {
  const siteId = sc.ctx.session.siteid;
  return raw(`<script>
			$(document).on('click', '.selectAssocImageResults ul li', function(e){
				if(e.target.tagName != 'INPUT'){
					$(this).find('input[type=radio]').prop('checked',true);
					return false;
				}
			});

			// set width of pane relative to side controls
			var resizeTabPane = function(offsetVal=17){
				if ($('#mura-content-body-block').length){

					var blockW = $('#mura-content-body-block').width();
					var controlW = $('#mura-content-body-block .mura__edit__controls').width();
					var newW = (blockW - controlW) - offsetVal;

					$('#mura-content-body-block .block-content.tab-content').css('width',newW + 'px');
					setTimeout(function(){
						resizeBodyEditor();
					}, 50)
				}
			}

			// set height of ckeditor content area - called by resizeTabPane()
			var resizeBodyEditor = function(){
				if ($('#mura-content-body-render .cke_contents').length){
					var ckeTopH = $('#mura-content-body-render .cke_top').height();
					var adminHeaderH = $('#mura-content .mura-header').height();
					var offsetH = ckeTopH + adminHeaderH;
					// also adjust cke height
					$('#mura-content-body-render .cke_contents').css('height','calc((100vh - ' + offsetH +  'px) - 283px)');
				}
			}

			$(window).on("load", function() {
				resizeTabPane();
				$('#mura-content-body-render').show();
			});

			$(document).ready(function(){

				// resizable editing panel
				$('#mura-content .mura__edit__controls').resizable({
					handles:'w',
					maxWidth: 640,
					minWidth: 300,
					resize: function (event,ui) {
		                // overlay prevents ckeditor iframe from stealing cursor focus
		                var frameParent = $('#mura-content-body-render');
		                var overlay = $(frameParent).find('.hidden-dialog-overlay');
				        if (!overlay.length) {
				            overlay = $('<div class="hidden-dialog-overlay" style="position:absolute;top:0;left:0;right:0;bottom:0;z-index:100000; width: 100%; height: 100%;"></div>');
				            overlay.appendTo(frameParent);
				        } else {
				            overlay.show();
				        }
				        resizeTabPane();
				        ui.position.left = ui.originalPosition.left;
			     	},
					stop: function(event,ui){
						var acw = $(this).width();
		                var frameParent = $('#mura-content-body-render');
			 			$(frameParent).find('.hidden-dialog-overlay').hide();
			        	resizeTabPane();
			 			createCookie('ADMINCONTROLWIDTH',acw,5);
					}
				});

				// persist side navigation expand/collapse
				$('*[data-action=sidebar_mini_toggle]').click(function(){
					var asb = 'on';
					// adjust sidebar as needed
					resizeTabPane();
					// set adminsidebar cookie
					if($('#page-container').hasClass('sidebar-mini')){
						asb = 'off';
					}
		 			createCookie('ADMINSIDEBAR',asb,5);
				});

				// persist open nav items
				$('#sidebar .nav-main li ul li a.active').parents('li').parents('ul').parents('li').addClass('open');

				//nice-select
				$('.mura__edit__controls .mura-control-group select').niceSelect();

				// header-search
				$('#mura-header-search-reveal').click(
				function(){
					$(this).hide();
					$('#mura-header-search').show();
				});

				// site list filter
				var sitefilter = jQuery('#site-list-filter');
				var sitelist = jQuery('ul#site-selector-list');
				var sitelistw = jQuery(sitelist).width();
				jQuery(sitelist).find('.ui-widget').click(function(){
					return false;
				})
				jQuery(sitefilter).click(function(){
					return false;
				});
				jQuery(sitelist).css('width',sitelistw);
				jQuery(sitefilter).keyup(function(){
					var str = jQuery(this).val();
					jQuery(sitelist).find('li').hide();
					if (str == ''){
						jQuery(sitelist).find('li').show();
					} else {
						jQuery(sitelist).find('li:contains(' + str + ')').show();
					}
				});

				// min-height for page content area
				var setBlockHeight = function(){
					var bc = $('#mura-content .block-constrain');
					var minFooterH = 15;
					var paddingH = 70;
					var windowH = $(window).height();
					var navbarH = $('#header-navbar:first').height();
					var headerH = $('.mura-header:first').height();
					var footerH = $('.mura-actions:first').height();
					if (footerH <= minFooterH){ footerH = minFooterH;}
					if ($(bc).length > 1){
						$.each(bc,function(){
							if($(this)[0] !== $(bc).last()[0]){
								footerH = footerH + $(this).height();
							}
						});
					}
					var subtr = paddingH + navbarH + headerH + footerH;
					var h = windowH - subtr;

					$(bc).last().css('min-height',h + 'px');
				};
				// run on page load
				setBlockHeight();
				// run on window resize
				$(window).on('resize',function(){
					setBlockHeight();
					resizeTabPane();
				});

				// tabdrop: trigger on page load w/ slight delay
				if ( $( '.mura-tabs').length ) {
					var triggerTabDrop = function(){
						setTimeout(function(){
							$('.mura-tabs').tabdrop({text: '<i class="mi-chevron-down"></i>'});
							$('.tabdrop .dropdown-toggle').parents('.nav-tabs').css('overflow-y','visible');
							$('.tabdrop a.dropdown-toggle .display-tab').html('<i class="mi-chevron-down"></i>');
						}, 10);
					}
					// run on page load
					triggerTabDrop();
					// run on resize
					$(window).on('resize',function(){
						$('.nav-tabs').css('overflow-y','hidden').find('li.tabdrop').removeClass('open').find('.dropdown-backdrop').remove();
							triggerTabDrop();
					});
					$('.tabdrop .dropdown-toggle').on('click',function(){
						$(this).parents('.nav-tabs').css('overflow-y','visible');
					});
				}
				// /tabdrop

				// dismiss alerts
				$('.alert-dismiss').click(
					function(){
						var _alert=this;
						$.ajax(
							{
								url:'./',
								data:{
									siteid:'${encodeJs(siteId)}',
									alertid:$(_alert).attr('data-alertid'),
									muraaction:'cdashboard.dismissAlert'
								},
								success: function(){
									$(_alert).parent('.alert').fadeOut();
								}
							}
						);
					}
				);

				// click to close new table actions, category selector filter
				document.onclick = function(e) {
				if (jQuery('#newContentMenu').length > 0){
				  if(!(jQuery(e.target).parents().hasClass('addNew')) && !(jQuery(e.target).parents().hasClass('add')) && !(jQuery(e.target).hasClass('add'))){
			     	jQuery('#newContentMenu').addClass('hide');
		    	}
				};

				if (jQuery('.actions-menu').length > 0){
			    if(!(jQuery(e.target).parents().hasClass('actions-menu')) && !(jQuery(e.target).parents().hasClass('actions-list')) && !(jQuery(e.target).parents().hasClass('show-actions')) && !(jQuery(e.target).hasClass('actions-list'))){
			       jQuery('.actions-menu').addClass('hide');
		     	}
				};

				if(jQuery('#category-select-list').length > 0){
			    if(!(jQuery(e.target).parents().hasClass('category-select')) && !(jQuery(e.target).parents().hasClass('categories'))){
			    	jQuery('#category-select-list').slideUp('fast');
				    }
					}
				};
				// /click to close

			});

			
			${renderMuraInit(sc)}

			</script>`);
}

/** The compact layout's `<script type="text/javascript">…</script>` (`compact.cfm` 139-300) for `frontEndProxyLoc`. */
export function renderCompactScripts(
  sc: ShellContext,
  frontEndProxyLoc: string = effectiveFrontEndProxyLoc(sc.ctx),
): SafeHtml {
  const { context, adminDir } = legacySettings();
  const sourceFrame = sc.ctx.rc.sourceFrame ?? 'modal';
  return raw(`<script type="text/javascript">

			var resizeTabPane = function(offsetVal=17){

				// set width of pane relative to side controls
				if ($('#mura-content-body-block').length){

					var blockW = $('#mura-content-body-block').width();
					var controlW = $('#mura-content-body-block .mura__edit__controls').width();
					var newW = (blockW - controlW) - offsetVal;

					$('#mura-content-body-block .block-content.tab-content').css('width',newW + 'px');
					setTimeout(function(){
						resizeBodyEditor();
					}, 50)
				}
				// set heights, accounting for header
				if ($('#dspStatusContainer').length){
					var tabContent = $('#mura-content-body-block>.tab-content');
					var controls = $('#mura-content-body-block .mura__edit__controls');
					var statusH = $('#dspStatusContainer').height();
					var origBlockH = $('#mura-content-body-block').height();
					var origTabH = $(tabContent).height();
					var origControlsH = $(controls).height();
					var newBlockH = origBlockH - statusH;
					var newTabH = origTabH - statusH + 90;
					var newControlsH = origControlsH - statusH + 12;

					$('#mura-content-body-block').css('height',newBlockH);
					$(tabContent).css('height',newTabH);
					$(controls).css('height',newControlsH);
				}

			}

			// set height of ckeditor content area - called by resizeTabPane()
			var resizeBodyEditor = function(){
				if ($('#mura-content-body-render .cke_contents').length){
					var ckeTopH = $('#mura-content-body-render .cke_top').height();
					var statusH = 0;
					var topH = 0;

					if ($("#dspStatusContainer").length){
						statusH = $("#dspStatusContainer").height();
					};

				 	topH = statusH + ckeTopH;

					$('#mura-content-body-render .cke_contents').css('height','calc((100vh - ' + topH +  'px) - 260px)');
				}
			}

			$(window).on("load", function() {
				resizeTabPane();
				$('#mura-content-body-render').show();
			});

			var frontEndProxy;
			jQuery(document).ready(function(){


				//nice-select
				Mura(function(){
					$('.mura__edit__controls .mura-control-group select').niceSelect();
				});

				// tabdrop: trigger on page load w/ slight delay
				if ( $( '.mura-tabs').length ) {
					var triggerTabDrop = function(){
						setTimeout(function(){
							$('.mura-tabs').tabdrop({text: '<i class="mi-chevron-down"></i>'});
								$('.tabdrop .dropdown-toggle').parents('.nav-tabs').css('overflow-y','visible');
								$('.tabdrop a.dropdown-toggle .display-tab').html('<i class="mi-chevron-down"></i>');
						}, 10);
					}
					// run on page load
					triggerTabDrop();
					// run on resize
					$(window).on('resize',function(){
						$('.nav-tabs').css('overflow-y','hidden').find('li.tabdrop').removeClass('open').find('.dropdown-backdrop').remove();
							triggerTabDrop();
					});
					$('.tabdrop .dropdown-toggle').on('click',function(){
						$(this).parents('.nav-tabs').css('overflow-y','visible');
					});
				}
				// /tabdrop

				if (top.location != self.location) {

					function getHeight(){
						if(document.all){
							return Math.max(document.body.scrollHeight, document.body.offsetHeight,160);
						} else {
							return Math.max(document.body.scrollHeight, document.body.offsetHeight, document.documentElement.scrollHeight, document.documentElement.offsetHeight,160);
						}
					}

					frontEndProxy = new Porthole.WindowProxy("${encodeJs(frontEndProxyLoc)}${context}${adminDir}/assets/js/porthole/proxy.html");
					frontEndProxy.post({cmd:
											'setHeight',
											height:getHeight(),
											'targetFrame': '${encodeJs(sourceFrame)}'
										});
					jQuery(this).resize(function(e){
						frontEndProxy.post({cmd:
											'setHeight',
											height:getHeight(),
											'targetFrame': '${encodeJs(sourceFrame)}'
										});
					});

					if(typeof siteManager != 'undefined'){
						frontEndProxy.addEventListener(siteManager.frontEndProxyListener);
					}
				};

				// click to close new table actions, category selector filter
				document.onclick = function(e) {
				if (jQuery('#newContentMenu').length > 0){
				  if(!(jQuery(e.target).parents().hasClass('addNew')) && !(jQuery(e.target).parents().hasClass('add')) && !(jQuery(e.target).hasClass('add'))){
			     	jQuery('#newContentMenu').addClass('hide');
		    	}
				};

				if (jQuery('.actions-menu').length > 0){
			    if(!(jQuery(e.target).parents().hasClass('actions-menu')) && !(jQuery(e.target).parents().hasClass('actions-list')) && !(jQuery(e.target).parents().hasClass('show-actions')) && !(jQuery(e.target).hasClass('actions-list'))){
			       jQuery('.actions-menu').addClass('hide');
		     	}
				};

				if(jQuery('#category-select-list').length > 0){
			    if(!(jQuery(e.target).parents().hasClass('category-select')) && !(jQuery(e.target).parents().hasClass('categories'))){
			    	jQuery('#category-select-list').slideUp('fast');
				    }
					}
				};
				// /click to close

			});

			
			${renderMuraInit(sc)}
		</script>`);
}
