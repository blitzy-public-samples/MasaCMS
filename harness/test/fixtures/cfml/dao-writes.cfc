<!--- DAO sample with cfquery writes, a cfthread write and a re-login --->
<cfcomponent extends="mura.cfobject" output="false">

<cffunction name="create" output="false">
	<cfargument name="data" type="struct" required="true">
	<cfquery>
		INSERT INTO tfixture (fixtureID, SiteID, name)
		VALUES (
			<cfqueryparam cfsqltype="cf_sql_varchar" value="#arguments.data.fixtureid#">,
			<cfqueryparam cfsqltype="cf_sql_varchar" value="#arguments.data.siteid#">,
			<cfqueryparam cfsqltype="cf_sql_varchar" value="#arguments.data.name#">
		)
	</cfquery>
</cffunction>

<cffunction name="update" output="false">
	<cfargument name="userid" type="string" required="true">
	<cfargument name="name" type="string" default="">
	<cfquery>
		UPDATE tfixture SET
			name = <cfqueryparam cfsqltype="cf_sql_varchar" value="#arguments.name#">
		WHERE userid = <cfqueryparam cfsqltype="cf_sql_varchar" value="#arguments.userid#">
	</cfquery>
</cffunction>

<cffunction name="deleteMembership" output="false">
	<cfargument name="userid" type="string" required="true">
	<cfargument name="groupid" type="string" required="true">
	<cfquery>
		DELETE FROM tfixturemembers WHERE userid = <cfqueryparam cfsqltype="cf_sql_varchar" value="#arguments.userid#"> and groupid = <cfqueryparam cfsqltype="cf_sql_varchar" value="#arguments.groupid#">
	</cfquery>
</cffunction>

<cffunction name="trackAsync" output="false">
	<cfargument name="siteid" type="string" required="true">
	<cfthread action="run" name="fixtureThread#createUUID()#" priority="low" siteid="#arguments.siteid#">
		<cfquery>
			INSERT INTO tfixturestats (statid, siteid)
			VALUES (<cfqueryparam cfsqltype="cf_sql_varchar" value="#createUUID()#">, <cfqueryparam cfsqltype="cf_sql_varchar" value="#attributes.siteid#">)
		</cfquery>
	</cfthread>
</cffunction>

<cffunction name="refreshLogin" output="false">
	<cfargument name="userBean" type="any" required="true">
	<cfset arguments.userBean.login()>
</cffunction>

</cfcomponent>
