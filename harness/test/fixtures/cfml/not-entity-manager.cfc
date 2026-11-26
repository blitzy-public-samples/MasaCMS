<!--- Manager sample whose string literal holds generated ORM component source --->
<cfcomponent extends="mura.cfobject" displayname="FixtureManager" output="false">

<cffunction name="createEntitySource" output="false">
	<cfargument name="name" type="string" required="true">
	<cfscript>
		var con = 'component extends="mura.bean.beanORM" table="fb_#lcase(arguments.name)#" entityName="#lcase(arguments.name)#" {';
		return con;
	</cfscript>
</cffunction>

</cfcomponent>
