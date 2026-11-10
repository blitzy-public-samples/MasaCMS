<!--- DI1 directory scan and alias registration sample --->
<cfscript>
	variables.serviceFactory=new mura.bean.beanFactory("/mura",{
			recurse=true,
			exclude=["/.","/mura/autoUpdater/global","/mura/configBean.cfc","/mura/bean/beanFactory.cfc","/mura/cache/provider","/mura/moment.cfc","/mura/client/oath","/mura/client/api/json/v1/apiUtility.cfc","/mura/client/api/feed/v1/apiUtility.cfc"],
			strict=application.configBean.getStrictFactory(),
			transientPattern = "(Iterator|Bean|executor|MuraScope|Event|dbUtility|extendObject)$"
			});

	variables.serviceFactory.addAlias("user","userBean");
	variables.serviceFactory.addAlias("group","userBean");
	variables.serviceFactory.addAlias("fixture","fixtureBean");
</cfscript>
