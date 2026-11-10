// Manager sample with parameterised writes, a thread write, a re-login and a bean call
component extends="mura.cfobject" output="false" {

	public any function rename(required string userid, required string name) {
		queryExecute("UPDATE tfixture SET name = :name WHERE userid = :userid", {name=arguments.name, userid=arguments.userid});
	}

	public any function purgeSite(required string siteid) {
		queryExecute("DELETE FROM tfixture WHERE siteid = :siteid", {siteid=arguments.siteid});
	}

	public any function trackStats(required string siteid) {
		thread action="run" name="fixtureStats" siteid=arguments.siteid {
			queryExecute("INSERT INTO tfixturestats (statid, siteid) VALUES (:statid, :siteid)", {statid=createUUID(), siteid=attributes.siteid});
		}
	}

	public any function refreshLogin(required any userBean) {
		arguments.userBean.login();
	}

	public any function create(required string fixtureid, required string siteid, string name="") {
		return getBean('fixtureDAO').create(arguments);
	}

}
